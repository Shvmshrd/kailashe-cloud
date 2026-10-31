/**
 * `kailashe deploy [dir]` — publish a static site to kailashe.com and get
 * the live `https://<label>.kailashe.com` address.
 *
 * kailashe.com hosts static HTML only, so the flow is:
 *   1. Detect the project (deterministic detector, no LLM).
 *   2. Static fit check. A dynamic project, a server app, or a folder
 *      without an index.html entry is refused with the not-fit message
 *      (exit 6) before any network call.
 *   3. Publish the folder as-is via the platform MCP endpoint
 *      (KAILASHE_TOKEN bearer credential, never logged or persisted).
 *   4. Verify the live subdomain answers, then record the deploy in
 *      `.kailashe/deploy-state.json` — the business plan and Muse prompt
 *      steps that follow read the production URL from there.
 */

import { Command } from "commander";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { text as clackText, isCancel } from "@clack/prompts";
import { DeployStateSchema, type DeployState } from "@kailashe/core/schemas/deploy-state.js";
import { detectProjectProfile, type DetectedProfile } from "@kailashe/scan";
import {
  KAILASHE_COM_NOT_FIT_MESSAGE,
  KailasheComAuthError,
  KailasheComClient,
  KailasheComError,
  assessKailasheComFit,
  collectStaticSite,
  validateSubdomainLabel,
  type KailasheComPublishResult,
} from "@kailashe/deploy";
import { ExitCode, KailasheError, NeedsInputError, ValidationError } from "../exit-codes.js";

// ---------------------------------------------------------------------------
// Injectable dependencies (tests pass fakes; no network in unit tests)
// ---------------------------------------------------------------------------

export interface DeployPublishClient {
  readonly base: string;
  connection(): Promise<{ email: string | null }>;
  publishSite(input: {
    title: string;
    slug: string;
    site: Awaited<ReturnType<typeof collectStaticSite>>;
    share: "public" | "login" | "none";
    operationKey: string;
  }): Promise<KailasheComPublishResult>;
}

export interface DeployCommandDeps {
  env?: Record<string, string | undefined>;
  detectProfile?: (dir: string) => Promise<DetectedProfile>;
  createClient?: (opts: { baseUrl: string; token: string }) => DeployPublishClient;
  /** Unauthenticated fetch used only to verify the live URL answers. */
  verifyFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  promptLabel?: () => Promise<string | null>;
  now?: () => Date;
}

export interface DeployOutcome {
  status: "deployed" | "not-fit" | "unverified";
  slug: string | null;
  liveUrl: string | null;
  siteUrl: string | null;
  shareUrl: string | null;
  account: string | null;
  files: number;
  bytes: number;
  skipped: number;
  stateFile: string | null;
  reasons: string[];
}

export interface DeployRunOptions {
  dir: string;
  label?: string;
  title?: string;
  baseUrl?: string;
  share: "public" | "login" | "none";
}

const DEFAULT_BASE_URL = "https://www.kailashe.com";

function defaultPromptLabel(): Promise<string | null> {
  return (async () => {
    const answer = await clackText({
      message: "Pick your subdomain label (your site will be https://<label>.kailashe.com):",
    });
    if (isCancel(answer)) return null;
    return String(answer);
  })();
}

/** Deterministic recovery key: same slug + same content → same key. */
export function deployOperationKey(
  slug: string,
  site: Awaited<ReturnType<typeof collectStaticSite>>,
): string {
  const hash = createHash("sha256");
  for (const file of site.files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `deploy-${slug}-${hash.digest("hex").slice(0, 16)}`;
}

function stateForDeploy(input: {
  slug: string;
  result: KailasheComPublishResult;
  now: Date;
}): DeployState {
  const at = input.now.toISOString();
  return DeployStateSchema.parse({
    version: 1,
    projectId: input.slug,
    provider: "kailashe-com",
    planId: "kailashe-com-deploy",
    url: input.result.liveUrl,
    resources: [
      {
        name: input.slug,
        kind: "site",
        provider: "kailashe-com",
        resourceId: input.slug,
        tags: { "kailashe-project": input.slug },
        createdAt: at,
        details: {
          siteUrl: input.result.siteUrl,
          shareUrl: input.result.shareUrl,
        },
      },
    ],
    createdAt: at,
    updatedAt: at,
    stepLog: [
      {
        step: 0,
        command: ["mcp", "kailashe_publish", input.slug],
        status: "succeeded",
        startedAt: at,
        finishedAt: at,
        exitCode: 0,
        outputSnippet: input.result.liveUrl,
        resourceId: input.slug,
        error: null,
      },
    ],
    status: "deployed",
  });
}

async function verifyLiveUrl(
  url: string,
  fetchFn: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, { method: "GET" });
      if (res.status === 200) return true;
    } catch {
      /* retry below */
    }
    if (attempt < 2) await sleep(1500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core flow
// ---------------------------------------------------------------------------

export async function runDeploy(
  opts: DeployRunOptions,
  deps: DeployCommandDeps = {},
): Promise<DeployOutcome> {
  const env = deps.env ?? process.env;
  const root = path.resolve(opts.dir);
  if (!existsSync(root)) {
    throw new KailasheComError(`Directory not found: ${root}`);
  }

  // 1–2. Detect + static fit, before any credential or network step.
  const profile = await (deps.detectProfile ?? detectProjectProfile)(root);
  const site = await collectStaticSite(root).catch((err: unknown) => {
    // A missing index.html is a fit outcome, not a crash: report it below.
    if (err instanceof KailasheComError && /No index\.html/.test(err.message)) return null;
    throw err;
  });
  const fit = assessKailasheComFit({
    appType: profile.appType.value,
    artifactKind: profile.artifactKind.value,
    rendering: profile.rendering.value,
    hasIndexHtml: site !== null,
  });
  if (!fit.fit || site === null) {
    return {
      status: "not-fit",
      slug: null,
      liveUrl: null,
      siteUrl: null,
      shareUrl: null,
      account: null,
      files: 0,
      bytes: 0,
      skipped: 0,
      stateFile: null,
      reasons: fit.reasons,
    };
  }

  // 3. Label (the <label>.kailashe.com subdomain the user selects).
  let label = opts.label;
  if (label === undefined || label.trim() === "") {
    const prompted = await (deps.promptLabel ?? defaultPromptLabel)();
    if (prompted === null || prompted.trim() === "") {
      throw new NeedsInputError(
        "A subdomain label is required: re-run with --label <label> (your site will be https://<label>.kailashe.com).",
      );
    }
    label = prompted;
  }
  const labelCheck = validateSubdomainLabel(label);
  if (!labelCheck.ok) {
    throw new ValidationError(`Invalid subdomain label: ${labelCheck.reason}.`);
  }
  if (labelCheck.label.length < 3) {
    throw new ValidationError("Invalid subdomain label: label must be at least 3 characters long.");
  }
  const slug = labelCheck.label;

  // 4. Credential: environment only, never read from credential files.
  const token = env["KAILASHE_TOKEN"] ?? env["ARTIFACT_HUB_TOKEN"];
  if (token === undefined || token.trim() === "") {
    throw new KailasheComAuthError(
      "No Kailashe token. Create a personal token in your account on kailashe.com, set it as the KAILASHE_TOKEN environment variable in your own terminal, then re-run. Never paste a token into chat or commit it.",
    );
  }

  const baseUrl = (opts.baseUrl ?? env["KAILASHE_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const client = (deps.createClient ?? (({ baseUrl: b, token: t }) => new KailasheComClient({ baseUrl: b, token: t })))({
    baseUrl,
    token,
  });

  const connection = await client.connection();
  const title = opts.title ?? slug;
  const result = await client.publishSite({
    title,
    slug,
    site,
    share: opts.share,
    operationKey: deployOperationKey(slug, site),
  });

  // 5. Record the deploy so the plan/prompt steps use the real URL.
  const now = (deps.now ?? (() => new Date()))();
  const stateFile = path.join(root, ".kailashe", "deploy-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(stateForDeploy({ slug, result, now }), null, 2)}\n`, "utf8");

  // 6. Verify the live address the way a visitor would (no credentials).
  const verified = await verifyLiveUrl(
    result.liveUrl,
    deps.verifyFetch ?? fetch,
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );

  return {
    status: verified ? "deployed" : "unverified",
    slug,
    liveUrl: result.liveUrl,
    siteUrl: result.siteUrl,
    shareUrl: result.shareUrl,
    account: connection.email,
    files: site.files.length,
    bytes: site.totalBytes,
    skipped: site.skipped.length,
    stateFile,
    reasons: fit.reasons,
  };
}

export function formatDeployOutcome(outcome: DeployOutcome): string[] {
  if (outcome.status === "not-fit") {
    return [...outcome.reasons.map((r) => `- ${r}`), KAILASHE_COM_NOT_FIT_MESSAGE];
  }
  const lines: string[] = [];
  lines.push(`Live: ${outcome.liveUrl}`);
  if (outcome.shareUrl !== null) lines.push(`Share this link: ${outcome.shareUrl}`);
  lines.push(`Site: ${outcome.siteUrl}`);
  if (outcome.account !== null) lines.push(`Published under: ${outcome.account}`);
  lines.push(`Files: ${outcome.files} (${outcome.bytes} bytes)`);
  if (outcome.skipped > 0) {
    lines.push(`Skipped ${outcome.skipped} hidden or excluded path(s) — not uploaded (the platform cannot serve them).`);
  }
  if (outcome.stateFile !== null) lines.push(`Deploy recorded in: ${outcome.stateFile}`);
  if (outcome.status === "unverified") {
    lines.push(
      "Note: the site is published, but the live address did not answer 200 yet — DNS or propagation may still be settling. Check the share/site link above in a minute.",
    );
  }
  lines.push("");
  lines.push("Next steps (the operator loop continues with this exact production URL):");
  lines.push(`- business plan: write business-plan.md for the site live at ${outcome.liveUrl}`);
  lines.push(`- Muse prompt: compose prompt.md with ${outcome.liveUrl} as the production address`);
  lines.push("- then: kailashe gate prompt.md");
  return lines;
}

function exitCodeForError(err: unknown): number {
  if (err instanceof KailasheError) return err.exitCode;
  if (err instanceof KailasheComAuthError) return ExitCode.ProviderAuth;
  if (err instanceof KailasheComError) {
    if (err.kind === "validation") return ExitCode.Validation;
    if (err.kind === "auth") return ExitCode.ProviderAuth;
    return ExitCode.DeployFailed;
  }
  return ExitCode.Unexpected;
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

export function createDeployCommand(deps: DeployCommandDeps = {}): Command {
  const cmd = new Command("deploy")
    .description("publish a static site to kailashe.com at https://<label>.kailashe.com")
    .argument("[dir]", "static site directory (default: current directory)")
    .option("--label <label>", "subdomain label you select, e.g. bcard for bcard.kailashe.com")
    .option("--title <title>", "site title (default: the label)")
    .option("--base <url>", "kailashe.com base URL (default: https://www.kailashe.com)")
    .option("--share <policy>", "share link to create: public, login or none", "public")
    .option("--json", "emit the deploy outcome as one JSON object")
    .action(
      async (
        dir: string | undefined,
        flags: { label?: string; title?: string; base?: string; share: string; json?: boolean },
      ) => {
        if (flags.share !== "public" && flags.share !== "login" && flags.share !== "none") {
          console.error(`Invalid --share "${flags.share}" (expected public, login or none).`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        try {
          const outcome = await runDeploy(
            {
              dir: dir ?? process.cwd(),
              label: flags.label,
              title: flags.title,
              baseUrl: flags.base,
              share: flags.share,
            },
            {
              ...deps,
              // Only prompt when a human can answer; scripts must pass --label.
              promptLabel:
                deps.promptLabel ??
                (process.stdin.isTTY ? defaultPromptLabel : async () => null),
            },
          );
          if (flags.json) console.log(JSON.stringify(outcome, null, 2));
          else for (const line of formatDeployOutcome(outcome)) console.log(line);
          process.exitCode =
            outcome.status === "not-fit"
              ? ExitCode.Validation
              : outcome.status === "unverified"
                ? ExitCode.DeployFailed
                : ExitCode.Ok;
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = exitCodeForError(err);
        }
      },
    );
  return cmd;
}

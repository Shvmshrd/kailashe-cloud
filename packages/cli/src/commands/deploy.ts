/**
 * `kailashe deploy [dir]` — publish a static site to kailashe.com and get
 * the live `https://<label>.kailashe.com` address.
 *
 * kailashe.com hosts static HTML only, so the flow is:
 *   1. Detect the project (deterministic detector, no LLM).
 *   2. Static fit check. A dynamic project, a server app, or a folder
 *      without an index.html entry is refused with the not-fit message
 *      (exit 6) before any network call.
 *   3. Publish the folder as-is. Two credential routes, neither of which
 *      ever lets Kailashe read a credential file:
 *        - default: the platform's own CLI (`@kailashe/cli`) and the login
 *          it stores on this machine — checked with `whoami`, created with
 *          `kailashe login` when signed out, all through the safe runner;
 *        - when KAILASHE_TOKEN is set: the platform MCP endpoint with that
 *          bearer token (sent only in the Authorization header).
 *   4. Verify the live subdomain answers, then record the deploy in
 *      `.kailashe/deploy-state.json`.
 *   5. Generate the operator-loop documents from the deployed project —
 *      `business-plan.md` and a composed `prompt.md` for Muse — with the
 *      live URL as the production address (skip with `--no-plan`).
 */

import { Command } from "commander";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { text as clackText, isCancel } from "@clack/prompts";
import { DeployStateSchema, type DeployState } from "@kailashe/core/schemas/deploy-state.js";
import { SafeRunner } from "@kailashe/core/runner/runner.js";
import { detectProjectProfile, type DetectedProfile } from "@kailashe/scan";
import {
  KAILASHE_COM_NOT_FIT_MESSAGE,
  KailasheComAuthError,
  KailasheComClient,
  KailasheComError,
  assessKailasheComFit,
  collectStaticSite,
  ensurePlatformCliLogin,
  platformCliAllowlist,
  platformCliBinaryName,
  publishWithPlatformCli,
  validateSubdomainLabel,
  type KailasheComPublishResult,
} from "@kailashe/deploy";
import { ExitCode, KailasheError, NeedsInputError, ValidationError } from "../exit-codes.js";
import {
  generatePostDeployArtifacts,
  type GenerateArtifactsInput,
  type PostDeployArtifacts,
} from "./post-deploy.js";

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
  /** Platform-CLI client factory (used when no KAILASHE_TOKEN is set). */
  createCliClient?: (opts: { baseUrl: string; dir: string }) => DeployPublishClient;
  /** Unauthenticated fetch used only to verify the live URL answers. */
  verifyFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  promptLabel?: () => Promise<string | null>;
  /** Post-deploy business-plan/prompt generation (default: real pipeline). */
  generateArtifacts?: (input: GenerateArtifactsInput) => Promise<PostDeployArtifacts>;
  now?: () => Date;
}

export type DeployVia = "mcp" | "platform-cli";

export interface DeployOutcome {
  status: "deployed" | "not-fit" | "unverified";
  via: DeployVia | null;
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
  /** business-plan.md / prompt.md written after a successful publish. */
  artifacts: PostDeployArtifacts | null;
  /** Why artifact generation failed (the deploy itself still succeeded). */
  artifactsError: string | null;
}

export interface DeployRunOptions {
  dir: string;
  label?: string;
  title?: string;
  baseUrl?: string;
  share: "public" | "login" | "none";
  /** Generate business-plan.md + prompt.md after deploying (default true). */
  plan?: boolean;
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

/**
 * Default publish client backed by the platform's own CLI. All commands go
 * through the core SafeRunner (allowlist, redaction, audit); the CLI's
 * stored login is used by that CLI itself — the token file is never read
 * here. `connection()` is the login gate: whoami → login → whoami.
 */
function defaultCreateCliClient(opts: { baseUrl: string; dir: string }): DeployPublishClient {
  const binary = platformCliBinaryName();
  const runner = new SafeRunner({
    projectRoot: opts.dir,
    allowlist: platformCliAllowlist(binary),
    defaultTimeoutMs: 600_000,
  });
  const cli = { runner, binary, baseUrl: opts.baseUrl, cwd: opts.dir };
  return {
    base: opts.baseUrl,
    async connection() {
      const login = await ensurePlatformCliLogin(cli);
      return { email: login.account };
    },
    async publishSite(input) {
      // The platform CLI re-reads and validates the folder itself; `site`
      // was already collected above for the fit/limit checks.
      return publishWithPlatformCli({
        ...cli,
        dir: opts.dir,
        slug: input.slug,
        title: input.title,
        share: input.share,
        operationKey: input.operationKey,
      });
    },
  };
}

function stateForDeploy(input: {
  slug: string;
  result: KailasheComPublishResult;
  via: DeployVia;
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
          via: input.via,
        },
      },
    ],
    createdAt: at,
    updatedAt: at,
    stepLog: [
      {
        step: 0,
        command:
          input.via === "mcp"
            ? ["mcp", "kailashe_publish", input.slug]
            : ["kailashe", "publish", input.slug],
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
      via: null,
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
      artifacts: null,
      artifactsError: null,
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

  // 4. Credential route. With KAILASHE_TOKEN set, publish over MCP with
  //    that token. Otherwise use the platform CLI's stored login (checked,
  //    and created via `kailashe login` when needed, inside connection()).
  //    Either way the credential material itself is handled only by its
  //    owner — never read from a credential file, never logged.
  const baseUrl = (opts.baseUrl ?? env["KAILASHE_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = env["KAILASHE_TOKEN"] ?? env["ARTIFACT_HUB_TOKEN"];
  let via: DeployVia;
  let client: DeployPublishClient;
  if (token !== undefined && token.trim() !== "") {
    via = "mcp";
    client = (deps.createClient ?? (({ baseUrl: b, token: t }) => new KailasheComClient({ baseUrl: b, token: t })))({
      baseUrl,
      token,
    });
  } else {
    via = "platform-cli";
    client = (deps.createCliClient ?? defaultCreateCliClient)({ baseUrl, dir: root });
  }

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
  await writeFile(stateFile, `${JSON.stringify(stateForDeploy({ slug, result, via, now }), null, 2)}\n`, "utf8");

  // 6. Verify the live address the way a visitor would (no credentials).
  const verified = await verifyLiveUrl(
    result.liveUrl,
    deps.verifyFetch ?? fetch,
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );

  // 7. End to end: generate the business plan and the Muse prompt from the
  //    deployed project, addressed at the live URL. A failure here never
  //    fails the deploy — the site is already live.
  let artifacts: PostDeployArtifacts | null = null;
  let artifactsError: string | null = null;
  if (opts.plan !== false) {
    try {
      artifacts = await (deps.generateArtifacts ?? generatePostDeployArtifacts)({
        dir: root,
        slug,
        liveUrl: result.liveUrl,
        shareUrl: result.shareUrl,
        profile,
        now,
      });
    } catch (err) {
      artifactsError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: verified ? "deployed" : "unverified",
    via,
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
    artifacts,
    artifactsError,
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
  if (outcome.via === "platform-cli") {
    lines.push("Auth: platform CLI login stored on this machine (the token file is read only by that CLI).");
  }
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
  if (outcome.artifacts !== null) {
    lines.push("Operator loop documents generated (production address: the live URL above):");
    lines.push(`- business plan: ${outcome.artifacts.businessPlanFile}`);
    lines.push(`- Muse prompt: ${outcome.artifacts.promptFile}`);
    for (const file of outcome.artifacts.appendixFiles) lines.push(`- appendix: ${file}`);
    lines.push("- then: kailashe-cloud gate prompt.md");
  } else if (outcome.artifactsError !== null) {
    lines.push(
      `Note: the site is live, but business-plan/prompt generation failed: ${outcome.artifactsError}`,
    );
    lines.push("- re-run deploy (safe: same label + content updates the same site) to retry.");
  } else {
    lines.push("Next steps (the operator loop continues with this exact production URL):");
    lines.push(`- business plan: write business-plan.md for the site live at ${outcome.liveUrl}`);
    lines.push(`- Muse prompt: compose prompt.md with ${outcome.liveUrl} as the production address`);
    lines.push("- then: kailashe-cloud gate prompt.md");
  }
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
    .option("--no-plan", "deploy only: skip generating business-plan.md and prompt.md")
    .option("--json", "emit the deploy outcome as one JSON object")
    .action(
      async (
        dir: string | undefined,
        flags: { label?: string; title?: string; base?: string; share: string; plan?: boolean; json?: boolean },
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
              plan: flags.plan,
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

/**
 * kailashe.com publishing through the platform's own CLI — the login-first
 * route used by `kailashe deploy` when no KAILASHE_TOKEN is set.
 *
 * The official `@kailashe/cli` keeps its credential in its own store
 * (~/.config/kailashe/tokens/<host>) after `kailashe login`. That file is
 * read ONLY by that CLI: this module never opens it. Instead it runs the
 * CLI through an injected runner (production: the core SafeRunner with the
 * kailashe-com allowlist, mirrored in providers/kailashe-com.yaml):
 *
 *   1. `kailashe --json whoami`  — is this machine signed in?
 *   2. `kailashe login`          — only when signed out; inherited stdio so
 *      the user sees the device/browser prompt as it is printed.
 *   3. `kailashe --json publish <dir> --slug <label> …` — the publish.
 *
 * The base URL travels as the KAILASHE_URL environment variable (the
 * platform CLI's documented override), never as a credential. Every JSON
 * response is validated with Zod at the boundary. Tests inject a fake
 * runner — no network, no subprocess.
 */

import { z } from "zod";
import type { Allowlist, AllowlistEntry, RiskClass } from "@kailashe/core/runner/types.js";
import {
  KailasheComAuthError,
  KailasheComError,
  kailasheComLiveUrl,
  type KailasheComPublishResult,
} from "./kailashe-com.js";

// ---------------------------------------------------------------------------
// Runner abstraction (production impl: core SafeRunner)
// ---------------------------------------------------------------------------

export interface PlatformCliRunOptions {
  binary: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** "inherit" for the interactive login; "pipe" (captured) otherwise. */
  stdio?: "pipe" | "inherit";
  /** The deploy command itself is the user's approval for these commands. */
  skipApproval?: boolean;
}

export interface PlatformCliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PlatformCliRunner {
  run(opts: PlatformCliRunOptions): Promise<PlatformCliRunResult>;
}

// ---------------------------------------------------------------------------
// Allowlist (mirror of providers/kailashe-com.yaml — keep the two in sync)
// ---------------------------------------------------------------------------

export const KAILASHE_COM_PROVIDER_ID = "kailashe-com";
export const PLATFORM_CLI_PACKAGE = "@kailashe/cli";
export const PLATFORM_CLI_BINARY = "kailashe";

export const KAILASHE_COM_CLI_PATTERNS: readonly {
  pattern: string;
  class: RiskClass;
}[] = [
  { pattern: "kailashe --version", class: "read" },
  { pattern: "kailashe --json whoami", class: "read" },
  { pattern: "kailashe whoami", class: "read" },
  { pattern: "kailashe login", class: "iam-billing-network" },
  { pattern: "kailashe --json publish", class: "create" },
];

/**
 * The npm-global shim name for the platform CLI. On Windows the bare
 * `kailashe` name resolves to the extensionless sh shim, which cannot be
 * spawned directly — the .cmd shim is the executable one.
 */
export function platformCliBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "kailashe.cmd" : PLATFORM_CLI_BINARY;
}

/** SafeRunner allowlist for the platform CLI under the resolved shim name. */
export function platformCliAllowlist(binaryName: string = platformCliBinaryName()): Allowlist {
  const entries: AllowlistEntry[] = KAILASHE_COM_CLI_PATTERNS.map((entry) => {
    const tokens = entry.pattern.split(" ");
    if (tokens[0] !== PLATFORM_CLI_BINARY) {
      throw new KailasheComError(`Allowlist pattern does not start with ${PLATFORM_CLI_BINARY}: ${entry.pattern}`);
    }
    return { binary: binaryName, prefix: tokens.slice(1), riskClass: entry.class };
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Platform CLI JSON payloads (Zod at the boundary)
// ---------------------------------------------------------------------------

const WhoamiPayloadSchema = z
  .object({
    baseUrl: z.string().optional(),
    user: z
      .object({
        id: z.string().optional(),
        email: z.string().nullable().optional(),
        displayName: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    email: z.string().nullable().optional(),
    operator: z.boolean().optional(),
    tokenStatus: z.string().optional(),
  })
  .passthrough();

const PublishPayloadSchema = z
  .object({
    slug: z.string().min(1),
    kind: z.string().optional(),
    title: z.string().optional(),
    siteUrl: z.string().optional(),
    readerUrl: z.string().optional(),
    share: z.object({ url: z.string().optional() }).passthrough().nullable().optional(),
    claimUrl: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .passthrough();

export interface PlatformCliLoginState {
  signedIn: boolean;
  /** Account label for display (email, display name, or user id). */
  account: string | null;
  /** Platform tokenStatus when signed out (none / token_revoked / …). */
  tokenStatus: string | null;
}

export interface PlatformCliPublishResult extends KailasheComPublishResult {
  /** Set only for anonymous publishes; null when published while signed in. */
  claimUrl: string | null;
  expiresAt: string | null;
}

export interface PlatformCliOptions {
  runner: PlatformCliRunner;
  /** Resolved shim name (default: platformCliBinaryName()). */
  binary?: string;
  /** Platform base URL (default https://www.kailashe.com). */
  baseUrl: string;
  /** Working directory (the site folder being deployed). */
  cwd: string;
}

const WHOAMI_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 600_000;
const PUBLISH_TIMEOUT_MS = 600_000;

function notUsableError(detail: string): KailasheComAuthError {
  return new KailasheComAuthError(
    `The kailashe.com platform CLI is not usable (${detail}). Install it with ` +
      `\`npm install -g ${PLATFORM_CLI_PACKAGE}\`, or set KAILASHE_TOKEN in your own terminal and re-run. ` +
      "Kailashe never reads the CLI's stored token file.",
  );
}

/** Run one platform CLI command, mapping runner failures to typed errors. */
async function runCli(
  opts: PlatformCliOptions,
  args: readonly string[],
  runOpts: Pick<PlatformCliRunOptions, "timeoutMs" | "stdio"> = {},
): Promise<PlatformCliRunResult> {
  try {
    return await opts.runner.run({
      binary: opts.binary ?? platformCliBinaryName(),
      args,
      cwd: opts.cwd,
      env: { KAILASHE_URL: opts.baseUrl },
      timeoutMs: runOpts.timeoutMs ?? WHOAMI_TIMEOUT_MS,
      stdio: runOpts.stdio ?? "pipe",
      // Invoking `kailashe deploy` is the user's explicit approval for the
      // whoami/login/publish commands of the platform CLI.
      skipApproval: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "UntrustedBinaryError" || /Binary not found on sanitized PATH/.test(message)) {
      throw notUsableError(message);
    }
    throw err;
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KailasheComError(`The platform CLI returned unreadable ${what} output.`);
  }
}

// ---------------------------------------------------------------------------
// Login check → login → publish
// ---------------------------------------------------------------------------

/** `kailashe --json whoami`: is this machine signed in to kailashe.com? */
export async function checkPlatformCliLogin(opts: PlatformCliOptions): Promise<PlatformCliLoginState> {
  const result = await runCli(opts, ["--json", "whoami"]);
  if (result.exitCode !== 0) {
    throw notUsableError(`whoami exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  const payload = WhoamiPayloadSchema.parse(parseJson(result.stdout, "whoami"));
  const account =
    payload.email ?? payload.user?.email ?? payload.user?.displayName ?? payload.user?.id ?? null;
  const signedIn = payload.user != null || payload.operator === true || payload.tokenStatus === "ok";
  return {
    signedIn,
    account: signedIn ? (account ?? (payload.operator === true ? "operator" : null)) : null,
    tokenStatus: payload.tokenStatus ?? null,
  };
}

/**
 * Ensure the platform CLI is signed in: check first, run the interactive
 * `kailashe login` (inherited stdio) only when signed out, then re-check.
 */
export async function ensurePlatformCliLogin(opts: PlatformCliOptions): Promise<PlatformCliLoginState> {
  const before = await checkPlatformCliLogin(opts);
  if (before.signedIn) return before;

  await runCli(opts, ["login"], { timeoutMs: LOGIN_TIMEOUT_MS, stdio: "inherit" });

  const after = await checkPlatformCliLogin(opts);
  if (!after.signedIn) {
    throw new KailasheComAuthError(
      "The platform CLI is still not signed in after `kailashe login`. Run `kailashe login` in your own terminal, then re-run deploy.",
    );
  }
  return after;
}

/** Publish the site folder under `slug` via the signed-in platform CLI. */
export async function publishWithPlatformCli(
  opts: PlatformCliOptions & {
    dir: string;
    slug: string;
    title: string;
    share: "public" | "login" | "none";
    operationKey: string;
  },
): Promise<PlatformCliPublishResult> {
  const result = await runCli(
    opts,
    [
      "--json",
      "publish",
      opts.dir,
      "--slug",
      opts.slug,
      "--title",
      opts.title,
      "--share",
      opts.share,
      "--operation-key",
      opts.operationKey,
    ],
    { timeoutMs: PUBLISH_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new KailasheComError(
      `kailashe publish failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  }
  const payload = PublishPayloadSchema.parse(parseJson(result.stdout, "publish"));
  return {
    slug: payload.slug,
    siteUrl: payload.siteUrl ?? `${opts.baseUrl}/s/${payload.slug}`,
    liveUrl: kailasheComLiveUrl(opts.baseUrl, payload.slug),
    shareUrl: payload.share?.url ?? payload.readerUrl ?? null,
    title: payload.title ?? null,
    kind: payload.kind ?? null,
    claimUrl: payload.claimUrl ?? null,
    expiresAt: payload.expiresAt ?? null,
  };
}

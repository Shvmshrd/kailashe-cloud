/**
 * SafeRunner — the only path for cloud CLI calls.
 *
 * Guarantees:
 *  - execa with args array only, never with shell enabled
 *  - sanitized PATH (no empty / relative / project-local entries)
 *  - absolute CLI resolution via which/where lookup
 *  - refuses binaries that resolve inside project or node_modules
 *  - timeouts, output caps, secret redaction on every output path
 *  - append-only audit log (.kailashe/audit.jsonl, redacted, with resolved path+version)
 *  - ECR password flow: credential piped process-to-process, never logged
 *
 * SPEC §4.2, §5, §F2a.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execa, type Options as ExecaOptions } from "execa";

import { getMatchingEntry, isValidBinaryName } from "./allowlist.js";
import { appendAuditLog, getAuditLogPath } from "./audit.js";
import {
  createRedactor,
  isEcrPasswordCommand,
  redactCommand,
} from "./redaction.js";
import type {
  Allowlist,
  ApprovalCallback,
  RunnerConfig,
  RunOptions,
  RunResult,
} from "./types.js";
import {
  AllowlistDeniedError,
  ApprovalDeniedError,
  InjectionBlockedError,
  TimeoutError,
  UntrustedBinaryError,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000; // 1 MB

// ── Injection detection ───────────────────────────────────────────────────

/**
 * Substrings / patterns that indicate a shell-injection attempt.
 * A command arg containing any of these is blocked before allowlist checking.
 *
 * Covers the red-team suite: separators, substitution, redirects, path tricks,
 * encoded payloads, etc.
 */
const INJECTION_SUBSTRINGS: readonly string[] = [
  ";",
  "|",
  "&",
  "$",
  "`",
  ">",
  "<",
  "$(",
  "${",
  "&&",
  "||",
  ">>",
  "<<",
  "\n",
  "\r",
  "\0",
  "../",
  "..\\",
  "%2f",
  "%2F",
  "%00",
  "%2e",
  "%2E",
  "%5c",
  "%5C",
  "%252F",
  "%252f",
  "\u0000",
];

/**
 * Return a reason string if `value` contains an injection indicator, else null.
 * Case-insensitive for encoded payloads (we lower-case before checking those).
 */
export function detectInjection(value: string): string | null {
  const lower = value.toLowerCase();
  for (const pat of INJECTION_SUBSTRINGS) {
    // Encoded payloads: case-insensitive
    if (pat.startsWith("%")) {
      if (lower.includes(pat.toLowerCase())) {
        return `encoded payload pattern ${pat}`;
      }
    } else {
      if (value.includes(pat)) {
        // Human-friendly label
        if (pat === ";") return "command separator ;";
        if (pat === "|") return "pipe |";
        if (pat === "&") return "background / chain &";
        if (pat === "$") return "variable/substitution $";
        if (pat === "`") return "backtick substitution";
        if (pat === ">") return "redirect >";
        if (pat === "<") return "redirect <";
        if (pat === "$(") return "command substitution $(";
        if (pat === "${") return "parameter expansion ${";
        if (pat === "&&") return "command chain &&";
        if (pat === "||") return "command chain ||";
        if (pat === ">>") return "append redirect >>";
        if (pat === "<<") return "heredoc <<";
        if (pat === "\n") return "newline injection";
        if (pat === "\r") return "carriage return injection";
        if (pat === "\0" || pat === "\u0000") return "null byte injection";
        if (pat === "../") return "path traversal ../";
        if (pat === "..\\") return "path traversal ..\\";
        return `injection pattern ${JSON.stringify(pat)}`;
      }
    }
  }
  return null;
}

/**
 * Validate that `binary` and each entry in `args` contain no injection
 * indicators. Throws InjectionBlockedError on the first violation.
 */
export function assertNoInjection(binary: string, args: readonly string[]): void {
  // A binary must be a bare name — paths like "/tmp/evil/aws" or "../bin/aws"
  // are refused here even though "/" alone is legitimate inside args.
  if (!isValidBinaryName(binary)) {
    throw new InjectionBlockedError(binary, args, `binary ${JSON.stringify(binary)} is not a bare binary name`);
  }
  const r = detectInjection(binary);
  if (r !== null) {
    throw new InjectionBlockedError(binary, args, `binary contains ${r}`);
  }
  for (const arg of args) {
    const r2 = detectInjection(arg);
    if (r2 !== null) {
      throw new InjectionBlockedError(binary, args, `arg ${JSON.stringify(arg)} contains ${r2}`);
    }
  }
}

// ── PATH sanitization ─────────────────────────────────────────────────────

/**
 * Sanitize PATH: drop empty, relative, and project-local entries.
 * Returns a PATH string safe to use for subprocess resolution.
 */
export function sanitizePath(
  rawPath: string | undefined,
  projectRoot: string,
): string {
  if (!rawPath) return "";
  // Split on the platform delimiter; also split POSIX-style entries on ":"
  // so a colon-joined PATH (e.g. from a Unix env on Windows) is handled.
  const parts = rawPath
    .split(path.delimiter)
    .flatMap((p) => (p.startsWith("/") ? p.split(":") : [p]));
  const clean: string[] = [];
  const normalizedRoot = path.resolve(projectRoot);
  for (const p of parts) {
    if (p.length === 0) continue; // empty entry means "current dir" — drop
    if (!path.isAbsolute(p)) continue; // relative — drop
    const resolved = path.resolve(p);
    // Refuse entries inside the project directory (could be attacker-planted bins)
    if (isInsideDir(resolved, normalizedRoot)) continue;
    // Refuse entries with obvious injection chars
    if (detectInjection(p) !== null) continue;
    clean.push(p);
  }
  return clean.join(path.delimiter);
}

// ── Binary resolution ─────────────────────────────────────────────────────

/**
 * Resolve `binary` to an absolute path using the sanitized PATH.
 * Uses `which` (Unix) or `where` (Windows) for lookup.
 * Returns the resolved path, or throws if not found.
 */
export async function resolveBinary(
  binary: string,
  sanitizedPath: string,
): Promise<{ resolvedPath: string; version?: string }> {
  const isWin = os.platform() === "win32";
  const probeBin = isWin ? "where" : "which";

  // Try which/where first
  let resolvedPath: string | undefined;
  try {
    const result = await execa(probeBin, [binary], {
      env: { PATH: sanitizedPath } as Record<string, string>,
      timeout: 5_000,
      reject: false,
    });
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      // `where` on Windows can return multiple lines — take the first
      resolvedPath = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    }
  } catch {
    // which/where failed — fall through to PATH scan
  }

  // Fallback: scan sanitized PATH manually (works when which is not available)
  if (!resolvedPath) {
    const exts = isWin
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
    const dirs = sanitizedPath.split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, binary + ext);
        try {
          await fs.promises.access(candidate, fs.constants.X_OK);
          resolvedPath = candidate;
          break;
        } catch {
          // not found / not executable
        }
      }
      if (resolvedPath) break;
    }
  }

  if (!resolvedPath) {
    throw new Error(`Binary not found on sanitized PATH: ${binary}`);
  }

  // Try to get version — best effort, non-fatal if it fails
  let version: string | undefined;
  try {
    const v = await execa(resolvedPath, ["--version"], {
      timeout: 5_000,
      reject: false,
    });
    const raw = (v.stdout || v.stderr || "").trim();
    if (raw.length > 0) version = raw.split("\n")[0]?.trim();
  } catch {
    // ignore
  }

  return { resolvedPath, version };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Canonical spelling of a path: absolute, with symlinks/junctions and
 * Windows 8.3 short names (RUNNER~1) resolved to the real directory.
 * Falls back to the plain resolved path when the target does not exist.
 */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInsideDir(candidate: string, dir: string): boolean {
  // Compare canonical spellings: the same directory can be spelled two
  // ways (symlink alias, 8.3 short name on Windows CI), and a plain
  // path.relative() between spellings escapes the root — which would
  // let a project-local binary slip past the refusal in run().
  const rel = path.relative(canonicalPath(dir), canonicalPath(candidate));
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return { text, truncated: false };
  // Truncate to maxBytes, append marker
  let truncated = text;
  while (Buffer.byteLength(truncated, "utf-8") > maxBytes) {
    truncated = truncated.slice(0, -100);
  }
  return { text: truncated + "\n[output truncated — exceeded cap]", truncated: true };
}

function mergeSecrets(
  runnerSecrets: ReadonlySet<string> | readonly string[] | undefined,
  runSecrets: ReadonlySet<string> | readonly string[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (runnerSecrets) for (const s of runnerSecrets) out.add(s);
  if (runSecrets) for (const s of runSecrets) out.add(s);
  // Also include well-known env secrets that are present in process.env
  const envSecretNames = [
    "MODEL_API_KEY",
    "KAILASHE_MODEL_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ];
  for (const name of envSecretNames) {
    const v = process.env[name];
    if (v && v.length >= 3) out.add(v);
  }
  return out;
}

// ── SafeRunner ────────────────────────────────────────────────────────────

export class SafeRunner {
  private readonly projectRoot: string;
  private readonly allowlist: Allowlist;
  private readonly secrets: ReadonlySet<string> | readonly string[] | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly approvalCallback?: ApprovalCallback;
  private readonly auditLogPath: string | null;
  private readonly sanitizedPath: string;

  public constructor(config: RunnerConfig) {
    this.projectRoot = path.resolve(config.projectRoot);
    this.allowlist = config.allowlist;
    this.secrets = config.secrets;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxOutputBytes = config.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.approvalCallback = config.approvalCallback;
    if (config.auditLogPath === null) {
      this.auditLogPath = null;
    } else if (config.auditLogPath) {
      this.auditLogPath = path.resolve(config.auditLogPath);
    } else {
      this.auditLogPath = getAuditLogPath(this.projectRoot);
    }
    const rawPath = config.pathEnv ?? process.env["PATH"];
    this.sanitizedPath = sanitizePath(rawPath, this.projectRoot);
  }

  /**
   * Execute a command through the safe runner.
   *
   * Steps:
   *  1. Injection check on binary + args
   *  2. Allowlist check
   *  3. Approval gate (if needed)
   *  4. Resolve binary to absolute path (which/where via sanitized PATH)
   *  5. Refuse if resolved path is inside project/node_modules
   *  6. execa with args array (never shell)
   *  7. Redact secrets on stdout/stderr, truncate to cap
   *  8. Append audit log (redacted, with resolved path + version)
   */
  public async run(options: RunOptions): Promise<RunResult> {
    const { binary, args } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;

    // 1. Injection check
    assertNoInjection(binary, args);

    // 2. Allowlist check
    const entry = getMatchingEntry(binary, args, this.allowlist);
    if (!entry) {
      throw new AllowlistDeniedError(binary, args);
    }

    // 3. Approval gate — create/modify/delete/iam-billing-network require approval
    const needsApproval =
      entry.riskClass !== "read" && !options.skipApproval;
    if (needsApproval) {
      if (!this.approvalCallback) {
        throw new ApprovalDeniedError(
          binary,
          args,
        );
      }
      const approved = await this.approvalCallback(entry, binary, args);
      if (!approved) {
        throw new ApprovalDeniedError(binary, args);
      }
    }

    // 4. Resolve binary to absolute path
    const { resolvedPath, version } = await resolveBinary(binary, this.sanitizedPath);

    // 5. Refuse binaries inside project directory / node_modules
    if (isInsideDir(resolvedPath, this.projectRoot)) {
      throw new UntrustedBinaryError(binary, resolvedPath);
    }
    // Also refuse if inside any node_modules of project
    const nodeModulesPath = path.join(this.projectRoot, "node_modules");
    if (isInsideDir(resolvedPath, nodeModulesPath) || resolvedPath === nodeModulesPath) {
      throw new UntrustedBinaryError(binary, resolvedPath);
    }
    // Check path traversal in resolved path (should not happen post-resolution but defence in depth)
    if (resolvedPath.includes("..")) {
      throw new UntrustedBinaryError(binary, resolvedPath);
    }

    // 6. Execute with execa — args array only, explicit env with sanitized PATH
    const allSecrets = mergeSecrets(this.secrets, options.secrets);
    // Build env: start from current env, override PATH with sanitized
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env["PATH"] = this.sanitizedPath;
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        env[k] = v;
      }
    }

    // Add stdin secret to redaction set if provided (ECR flow)
    if (options.stdin && options.stdin.length >= 3) {
      allSecrets.add(options.stdin);
    }

    const redactor = createRedactor(allSecrets);
    const startMs = Date.now();
    let timedOut = false;
    let exitCode = 0;

    const execaOpts: ExecaOptions = {
      cwd: options.cwd ?? this.projectRoot,
      env,
      timeout: timeoutMs,
      reject: false,
      // execa defaults to no shell — a shell is never enabled here
      input: options.stdin,
      // Interactive logins (device/browser flows) inherit the terminal so the
      // user sees the sign-in URL/code live; output then cannot be captured.
      ...(options.stdio === "inherit" ? { stdio: "inherit" as const } : {}),
      // Ensure we capture output (disabled when stdio is inherited)
      buffer: options.stdio !== "inherit",
    };

    let rawStdout = "";
    let rawStderr = "";

    try {
      const result = await execa(resolvedPath, [...args], execaOpts);
      exitCode = result.exitCode ?? 0;
      rawStdout = typeof result.stdout === "string" ? result.stdout : "";
      rawStderr = typeof result.stderr === "string" ? result.stderr : "";
    } catch (err: unknown) {
      // execa throws on timeout even with reject:false in some versions
      if (err instanceof Error && (err as unknown as { timedOut?: boolean }).timedOut) {
        timedOut = true;
        // Try to extract partial output
        const e = err as unknown as { stdout?: string; stderr?: string; exitCode?: number };
        rawStdout = e.stdout ?? "";
        rawStderr = e.stderr ?? "";
        // Preserve exit code if available
        exitCode = e.exitCode ?? 124;
      } else {
        throw err;
      }
    }

    const durationMs = Date.now() - startMs;

    // Handle timeout detection via exit code / duration
    // execa sets exitCode undefined on timeout; we treat duration >= timeout as timeout
    if (!timedOut && durationMs >= timeoutMs && timeoutMs > 0) {
      // Heuristic: if duration hit timeout and exit is non-zero-ish, it likely timed out
      // Actual timeout is handled by execa killing the process
      // We leave timedOut as-is; caller can check duration
    }

    // 7. Redaction + truncation
    // For credentialOutput commands, stdout is a secret — replace in logs but return raw to caller
    const isCredential = options.credentialOutput === true || isEcrPasswordCommand(binary, args);

    if (isCredential && rawStdout.length >= 3) {
      // Treat stdout as a new secret — add to set for future runs
      allSecrets.add(rawStdout.trim());
    }

    // Truncate raw output to cap first (so caps bound what we keep), then
    // redact the truncated text. Redacting first could shrink a long
    // credential-like blob under the cap and hide that truncation happened.
    const stdoutTruncRaw = truncate(rawStdout, maxOutputBytes);
    const stderrTruncRaw = truncate(rawStderr, maxOutputBytes);
    const truncated = stdoutTruncRaw.truncated || stderrTruncRaw.truncated;

    // For credential flow, never return more than needed — but still respect caller's need
    // Return stdout is raw (unredacted) only for credential — truncated to cap above
    let finalStdout: string;
    let finalStderr: string;
    if (isCredential) {
      finalStdout = stdoutTruncRaw.text;
      finalStderr = redactor(stderrTruncRaw.text);
    } else {
      finalStdout = redactor(stdoutTruncRaw.text);
      finalStderr = redactor(stderrTruncRaw.text);
    }

    const result: RunResult = {
      exitCode,
      stdout: finalStdout,
      stderr: finalStderr,
      resolvedPath,
      version,
      riskClass: entry.riskClass,
      command: redactCommand(binary, args, allSecrets),
      durationMs,
      timedOut,
      truncated,
    };

    // 8. Append audit log (always redacted)
    if (this.auditLogPath) {
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          binary,
          args: [...args].map((a) => redactor(a)),
          resolvedPath,
          version,
          riskClass: entry.riskClass,
          exitCode,
          durationMs,
          cwd: options.cwd ?? this.projectRoot,
          timedOut,
          truncated,
          command: redactCommand(binary, args, allSecrets),
        },
        this.auditLogPath,
      );
    }

    if (timedOut) {
      throw new TimeoutError(binary, timeoutMs);
    }

    return result;
  }

  /**
   * Convenience: run an ECR login flow.
   * 1. aws ecr get-login-password -> capture (redacted in logs)
   * 2. docker login --username AWS --password-stdin <registry>
   * Password is piped via stdin, never appears in args or logs.
   */
  public async runEcrLogin(registry: string): Promise<RunResult> {
    // Step 1: get password
    const pwResult = await this.run({
      binary: "aws",
      args: ["ecr", "get-login-password"],
      credentialOutput: true,
    });
    if (pwResult.exitCode !== 0) {
      return pwResult;
    }
    // Step 2: docker login with password on stdin
    return this.run({
      binary: "docker",
      args: ["login", "--username", "AWS", "--password-stdin", registry],
      stdin: pwResult.stdout.trim(),
    });
  }

  /** Expose sanitized PATH for testing / debugging. */
  public getSanitizedPath(): string {
    return this.sanitizedPath;
  }

  /** Expose project root for testing. */
  public getProjectRoot(): string {
    return this.projectRoot;
  }
}

/**
 * Safe runner types — SPEC §4.2, §5, §F2a.
 *
 * All cloud CLI calls in all packages go through SafeRunner.
 */

// ── Risk classes ────────────────────────────────────────────────────────────

/**
 * Risk class for every allowlisted command.
 * Each class has its own approval prompt (SPEC §4.2).
 */
export type RiskClass =
  | "read"
  | "create"
  | "modify"
  | "delete"
  | "iam-billing-network";

/** All valid risk-class values. */
export const RISK_CLASSES: ReadonlySet<RiskClass> = new Set<RiskClass>([
  "read",
  "create",
  "modify",
  "delete",
  "iam-billing-network",
]);

export function isRiskClass(value: string): value is RiskClass {
  return (RISK_CLASSES as ReadonlySet<string>).has(value);
}

// ── Allowlist ─────────────────────────────────────────────────────────────

/**
 * A single allowlist entry: binary + subcommand prefix + risk class.
 *
 * Example: { binary: "aws", prefix: ["sts", "get-caller-identity"], riskClass: "read" }
 *   allows `aws sts get-caller-identity` plus any trailing flags.
 *
 * An empty prefix allows any subcommand for that binary (use sparingly).
 */
export interface AllowlistEntry {
  /** CLI binary name, e.g. "aws", "doctl", "vercel". Must be bare name, no path. */
  readonly binary: string;
  /** Required leading subcommand tokens. Empty = any subcommand for this binary. */
  readonly prefix: readonly string[];
  /** Risk class determines the approval gate. */
  readonly riskClass: RiskClass;
  /** Human-readable note for audit / error messages. */
  readonly description?: string;
}

/**
 * Per-provider allowlist — an array of entries.
 * A command is allowed if ANY entry matches (binary exact + prefix match).
 */
export type Allowlist = readonly AllowlistEntry[];

// ── Approval ──────────────────────────────────────────────────────────────

/**
 * Called before executing a non-read command (or any iam-billing-network command).
 * Return true to proceed, false to deny.
 */
export type ApprovalCallback = (
  entry: AllowlistEntry,
  binary: string,
  args: readonly string[],
) => boolean | Promise<boolean>;

// ── Run options / result ──────────────────────────────────────────────────

/**
 * Options for a single SafeRunner invocation.
 */
export interface RunOptions {
  /** Binary name, e.g. "aws". Must match an allowlist entry binary. */
  readonly binary: string;
  /** Arguments array — never shell-interpreted, only prefix-matched. */
  readonly args: readonly string[];
  /** Override per-run timeout (ms). Defaults to runner's defaultTimeoutMs. */
  readonly timeoutMs?: number;
  /** Override per-run output cap (bytes). Defaults to runner's defaultMaxOutputBytes. */
  readonly maxOutputBytes?: number;
  /** Working directory for the subprocess. Defaults to projectRoot. */
  readonly cwd?: string;
  /**
   * Extra env vars for this invocation. Merged over process.env (sanitized PATH).
   * Values are NOT redacted automatically — add secrets to `secrets` set instead.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Secrets whose occurrences must be redacted in every output path.
   * Merged with the runner-level secrets set.
   */
  readonly secrets?: ReadonlySet<string> | readonly string[];
  /**
   * If true, skip the approval callback even for create/modify/delete/iam.
   * Only use for pre-approved read flows or in tests.
   */
  readonly skipApproval?: boolean;
  /**
   * If true, treat stdout as a credential (e.g. `aws ecr get-login-password`).
   * Stdout is replaced with [REDACTED] in logs/audit and returned as raw
   * only to the caller for direct piping — never logged or sent to the model.
   */
  readonly credentialOutput?: boolean;
  /**
   * stdin content to pipe to the subprocess. Used for the ECR login flow:
   *   runner.run({ binary: "docker", args: ["login", ...], stdin: ecrPassword })
   * The stdin value is always redacted in logs/audit.
   */
  readonly stdin?: string;
  /**
   * Output handling. "pipe" (default) captures stdout/stderr for redaction,
   * truncation and audit. "inherit" attaches the subprocess to this process's
   * stdio — required for interactive provider logins (device/browser flows)
   * where the user must see the sign-in URL/code as it is printed. With
   * "inherit" nothing is captured, so stdout/stderr come back empty; the
   * audit log still records the (redacted) command, path, version and exit.
   */
  readonly stdio?: "pipe" | "inherit";
}

/**
 * Result of a SafeRunner invocation. stdout/stderr are already redacted
 * unless credentialOutput was set — then stdout is raw for piping.
 */
export interface RunResult {
  /** Process exit code (0 = success). */
  readonly exitCode: number;
  /** Stdout (redacted, truncated to maxOutputBytes). */
  readonly stdout: string;
  /** Stderr (redacted, truncated to maxOutputBytes). */
  readonly stderr: string;
  /** Resolved absolute path to the binary that was executed. */
  readonly resolvedPath: string;
  /** CLI version string if resolved (e.g. "aws-cli/2.15.0"), else undefined. */
  readonly version?: string;
  /** Risk class of the matched allowlist entry. */
  readonly riskClass: RiskClass;
  /** Human-readable command for logs (redacted). */
  readonly command: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** True if the process was killed due to timeout. */
  readonly timedOut: boolean;
  /** True if stdout or stderr was truncated due to output cap. */
  readonly truncated: boolean;
}

// ── Runner config ─────────────────────────────────────────────────────────

/**
 * Configuration for the SafeRunner instance.
 */
export interface RunnerConfig {
  /** Project root — used to refuse binaries inside project/node_modules. */
  readonly projectRoot: string;
  /** Per-provider allowlist (union of all provider allowlists in use). */
  readonly allowlist: Allowlist;
  /** Secrets to redact in every output path (env values, tokens, passwords). */
  readonly secrets?: ReadonlySet<string> | readonly string[];
  /** Default timeout per invocation (ms). Default: 60_000. */
  readonly defaultTimeoutMs?: number;
  /** Default max stdout+stderr bytes retained. Default: 1_000_000 (1 MB). */
  readonly defaultMaxOutputBytes?: number;
  /** Approval callback — required for create/modify/delete/iam-billing-network. */
  readonly approvalCallback?: ApprovalCallback;
  /**
   * Custom audit log path. Defaults to <projectRoot>/.kailashe/audit.jsonl
   * Set to null to disable audit logging (tests).
   */
  readonly auditLogPath?: string | null;
  /**
   * Sanitized PATH value. If omitted, derived from process.env.PATH.
   * Used to resolve binaries to absolute paths.
   */
  readonly pathEnv?: string;
}

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when a command is not on the allowlist. */
export class AllowlistDeniedError extends Error {
  public override readonly name = "AllowlistDeniedError";
  public constructor(
    public readonly binary: string,
    public readonly args: readonly string[],
    message?: string,
  ) {
    super(
      message ??
        `Command not allowlisted: ${binary} ${args.join(" ")}`.trim(),
    );
  }
}

/** Thrown when injection-like content is detected in binary or args. */
export class InjectionBlockedError extends Error {
  public override readonly name = "InjectionBlockedError";
  public constructor(
    public readonly binary: string,
    public readonly args: readonly string[],
    public readonly reason: string,
  ) {
    super(
      `Blocked potential injection in command ${binary} ${args.join(" ")}: ${reason}`.trim(),
    );
  }
}

/** Thrown when a binary resolves inside the project directory. */
export class UntrustedBinaryError extends Error {
  public override readonly name = "UntrustedBinaryError";
  public constructor(
    public readonly binary: string,
    public readonly resolvedPath: string,
  ) {
    super(
      `Refusing binary inside project directory: ${binary} resolved to ${resolvedPath}`,
    );
  }
}

/** Thrown when approval is denied. */
export class ApprovalDeniedError extends Error {
  public override readonly name = "ApprovalDeniedError";
  public constructor(
    public readonly binary: string,
    public readonly args: readonly string[],
  ) {
    super(`Approval denied for: ${binary} ${args.join(" ")}`.trim());
  }
}

/** Thrown when a command times out. */
export class TimeoutError extends Error {
  public override readonly name = "TimeoutError";
  public constructor(
    public readonly binary: string,
    public readonly timeoutMs: number,
  ) {
    super(`Command timed out after ${timeoutMs}ms: ${binary}`);
  }
}

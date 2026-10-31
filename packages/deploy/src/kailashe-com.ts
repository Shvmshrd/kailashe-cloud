/**
 * kailashe.com hosted publishing — the platform behind `kailashe deploy`.
 *
 * The hosted platform serves STATIC sites only: a finished HTML file tree
 * is uploaded as-is (no build step, no server runtime) and is served at
 * `https://<slug>.kailashe.com`. Publishing goes through the platform's
 * remote MCP endpoint (`$BASE/mcp`, streamable HTTP JSON-RPC) with a
 * Bearer token from the `KAILASHE_TOKEN` environment variable — the same
 * credential the platform CLI and MCP share. The token is only ever sent
 * in the Authorization header: never logged, never written to state.
 *
 * Contract source: https://www.kailashe.com/for-agents.md (fetched
 * 2026-11-01) and the `kailashe_publish` / `kailashe_upload_start` /
 * `kailashe_upload_write` tool schemas of the platform MCP server.
 *
 * All network access goes through an injectable `fetchFn` so unit tests
 * run against a fake MCP endpoint — no network in tests (AGENTS.md).
 * Every response is validated with Zod at the boundary.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants (platform limits, for-agents.md section 3)
// ---------------------------------------------------------------------------

export const DEFAULT_KAILASHE_COM_BASE_URL = "https://www.kailashe.com";

/** Inline MCP publish is used up to this approximate JSON payload size. */
export const MCP_INLINE_MAX_CHARS = 1_500_000;
/** One upload_write chunk decodes to at most 256 KiB. */
export const MCP_UPLOAD_CHUNK_BYTES = 262_144;
/** Platform caps: one version, one file, file count. */
export const PLATFORM_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
export const PLATFORM_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const PLATFORM_MAX_FILES = 2_000;

/** Shown to the user when a project cannot be hosted on kailashe.com yet. */
export const KAILASHE_COM_NOT_FIT_MESSAGE =
  "The website is not fit for Kailashe at the moment. Please stick around as we add more features to it.";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class KailasheComError extends Error {
  readonly httpStatus: number | undefined;
  readonly code: string | undefined;
  readonly kind: "auth" | "validation" | "deploy" = "deploy";

  constructor(message: string, opts: { httpStatus?: number; code?: string } = {}) {
    super(message);
    this.name = "KailasheComError";
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
  }
}

export class KailasheComValidationError extends KailasheComError {
  override readonly kind = "validation" as const;
  constructor(message: string) {
    super(message);
    this.name = "KailasheComValidationError";
  }
}

export class KailasheComAuthError extends KailasheComError {
  override readonly kind = "auth" as const;
  constructor(message: string, opts: { httpStatus?: number; code?: string } = {}) {
    super(message, opts);
    this.name = "KailasheComAuthError";
  }
}

// ---------------------------------------------------------------------------
// Static fit assessment (pure — the CLI feeds it detector output)
// ---------------------------------------------------------------------------

export interface KailasheComFitInput {
  appType: string;
  artifactKind: string;
  rendering: string;
  hasIndexHtml: boolean;
}

export interface KailasheComFit {
  fit: boolean;
  reasons: string[];
}

const SERVER_APP_TYPES = new Set([
  "express", "fastify", "nestjs", "fastapi", "django", "flask",
  "rails", "laravel", "go", "rust",
]);

/**
 * kailashe.com hosts static HTML only. A project fits when the detector
 * calls it static, it is not a server application, and the folder being
 * published already contains the `index.html` entry — the platform does
 * not build anything, so framework projects must publish their build
 * output folder, not their source tree.
 */
export function assessKailasheComFit(input: KailasheComFitInput): KailasheComFit {
  const reasons: string[] = [];

  if (input.rendering !== "static") {
    reasons.push(
      `This project is dynamic (${input.appType}) — it needs a server runtime, and kailashe.com only hosts static files.`,
    );
  }
  if (SERVER_APP_TYPES.has(input.appType)) {
    reasons.push(
      `This project is a server application (${input.appType}); only its built static output could be hosted, never the server itself.`,
    );
  }
  if (input.artifactKind !== "static-dir" && input.artifactKind !== "build-dir") {
    reasons.push(
      `This project produces a ${input.artifactKind} artifact, not a static file tree.`,
    );
  }
  if (!input.hasIndexHtml) {
    reasons.push(
      "No index.html entry was found in the folder to publish — the platform serves a finished static site as-is and does not run a build.",
    );
  }

  if (reasons.length > 0) return { fit: false, reasons };
  return {
    fit: true,
    reasons: ["Static HTML site — kailashe.com can host this folder as-is."],
  };
}

// ---------------------------------------------------------------------------
// Collecting the static file tree
// ---------------------------------------------------------------------------

export interface StaticSiteFile {
  /** Relative path inside the site, forward slashes (e.g. assets/app.css). */
  path: string;
  bytes: Uint8Array;
}

export interface CollectedStaticSite {
  files: StaticSiteFile[];
  totalBytes: number;
  /** Paths left out of the upload (hidden, excluded or unservable), for reporting. */
  skipped: string[];
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "__MACOSX"]);
const SKIP_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const TEXT_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".mjs", ".json", ".svg", ".xml", ".txt",
]);

async function walk(
  dir: string,
  prefix: string,
  out: StaticSiteFile[],
  skipped: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // Hidden and excluded trees are left out, never uploaded: the
      // platform rejects node_modules/.git outright and can never serve
      // a dot-path. This also keeps Kailashe's own `.kailashe/` state
      // directory out of every redeploy.
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        skipped.push(rel);
        continue;
      }
      await walk(path.join(dir, entry.name), rel, out, skipped);
    } else if (entry.isFile()) {
      if (SKIP_FILE_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        skipped.push(rel);
        continue;
      }
      const bytes = await readFile(path.join(dir, entry.name));
      out.push({ path: rel, bytes });
    } else {
      // Symlinks and special files are never followed into an upload.
      skipped.push(rel);
    }
  }
}

/**
 * Read a finished static site from disk: a directory tree with an
 * `index.html` at its root, or a single `.html` file (published as
 * `index.html`). Enforces the platform's hard limits before any network
 * call so a limit violation never becomes a half-upload.
 */
export async function collectStaticSite(target: string): Promise<CollectedStaticSite> {
  const info = await stat(target).catch(() => null);
  if (info === null) {
    throw new KailasheComValidationError(`Path not found: ${target}`);
  }

  const files: StaticSiteFile[] = [];
  const skipped: string[] = [];
  if (info.isFile()) {
    if (!/\.html$/i.test(target)) {
      throw new KailasheComValidationError(
        `Only a single .html file can be published directly (got ${path.basename(target)}). ${KAILASHE_COM_NOT_FIT_MESSAGE}`,
      );
    }
    files.push({ path: "index.html", bytes: await readFile(target) });
  } else if (info.isDirectory()) {
    await walk(target, "", files, skipped);
    if (!files.some((f) => f.path === "index.html")) {
      throw new KailasheComValidationError(
        `No index.html at the root of ${target}. The platform hosts a finished static site as-is (it does not run a build), so publish the folder that contains index.html — for example your build output folder.`,
      );
    }
  } else {
    throw new KailasheComValidationError(`Path is neither a file nor a directory: ${target}`);
  }

  if (files.length > PLATFORM_MAX_FILES) {
    throw new KailasheComValidationError(
      `Too many files: ${files.length} (platform limit is ${PLATFORM_MAX_FILES} per site).`,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.bytes.byteLength > PLATFORM_MAX_FILE_BYTES) {
      throw new KailasheComValidationError(
        `File too large: ${file.path} is ${file.bytes.byteLength} bytes (platform limit is ${PLATFORM_MAX_FILE_BYTES} per file).`,
      );
    }
    totalBytes += file.bytes.byteLength;
  }
  if (totalBytes > PLATFORM_MAX_TOTAL_BYTES) {
    throw new KailasheComValidationError(
      `Site too large: ${totalBytes} bytes (platform limit is ${PLATFORM_MAX_TOTAL_BYTES} per version).`,
    );
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, skipped };
}

/** True when a collected file should travel as UTF-8 text, not base64. */
function isTextFile(filePath: string, bytes: Uint8Array): boolean {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP JSON-RPC) client
// ---------------------------------------------------------------------------

const JsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.number(), z.string()]).optional(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ToolResultSchema = z
  .object({
    content: z
      .array(
        z
          .object({ type: z.string(), text: z.string().optional() })
          .passthrough(),
      )
      .optional(),
    structuredContent: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const SitePayloadSchema = z
  .object({
    slug: z.string().min(1).optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    site: z
      .object({
        slug: z.string().min(1).optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        kind: z.string().optional(),
      })
      .passthrough()
      .optional(),
    share: z
      .object({ url: z.string().optional() })
      .passthrough()
      .optional(),
    shareUrl: z.string().optional(),
  })
  .passthrough();

const UploadStartSchema = z
  .object({
    versionId: z.string().min(1).optional(),
    upload_id: z.string().min(1).optional(),
    uploadId: z.string().min(1).optional(),
  })
  .passthrough();

export interface KailasheComClientOptions {
  /** Platform base URL, default https://www.kailashe.com (no trailing slash). */
  baseUrl?: string;
  /** Bearer token (KAILASHE_TOKEN). Sent only in the Authorization header. */
  token: string;
  fetchFn?: typeof fetch;
}

export interface KailasheComConnection {
  /** Account email when the platform reports one. */
  email: string | null;
  raw: Record<string, unknown>;
}

export interface PublishSiteInput {
  title: string;
  /** Custom subdomain label: the site is served at https://<slug>.kailashe.com. */
  slug: string;
  site: CollectedStaticSite;
  /** Share policy to create with the publish; "none" creates no share link. */
  share?: "public" | "login" | "none";
  /**
   * Idempotency/recovery key, persisted by the caller before the write.
   * Reusing the same key with the same arguments recovers the same result
   * instead of publishing a copy (platform retains it for seven days).
   */
  operationKey: string;
}

export interface KailasheComPublishResult {
  slug: string;
  /** The site's own address on the platform (e.g. https://www.kailashe.com/s/<slug>). */
  siteUrl: string;
  /** The branded subdomain address: https://<slug>.kailashe.com. */
  liveUrl: string;
  /** Public share link (/v/<token>) when one was created. */
  shareUrl: string | null;
  title: string | null;
  kind: string | null;
}

function errorMessageFromBody(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const message = (parsed as { error?: unknown }).error;
      if (typeof message === "string" && message !== "") return message;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export class KailasheComClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private nextId = 1;
  private sessionId: string | null = null;
  private sessionStarted = false;

  constructor(opts: KailasheComClientOptions) {
    if (typeof opts.token !== "string" || opts.token.trim() === "") {
      throw new KailasheComAuthError(
        "No Kailashe token. Set the KAILASHE_TOKEN environment variable to your kailashe.com personal token (create one in your account on kailashe.com), then re-run. Never paste a token into chat or commit it.",
      );
    }
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_KAILASHE_COM_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get base(): string {
    return this.baseUrl;
  }

  /** Identity check (kailashe_connection) — run before any upload. */
  async connection(): Promise<KailasheComConnection> {
    const payload = await this.callTool("kailashe_connection", {});
    const record = typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
    let email: string | null = null;
    const user = record["user"];
    if (typeof user === "object" && user !== null) {
      const value = (user as Record<string, unknown>)["email"];
      if (typeof value === "string") email = value;
    }
    if (email === null && typeof record["email"] === "string") {
      email = record["email"];
    }
    return { email, raw: record };
  }

  /**
   * Publish a collected static site under `slug`, so it is served at
   * https://<slug>.kailashe.com. Small sites go inline in one
   * kailashe_publish call; larger ones stream through
   * kailashe_upload_start / kailashe_upload_write in 256 KiB chunks and
   * finish with kailashe_publish by upload_id.
   */
  async publishSite(input: PublishSiteInput): Promise<KailasheComPublishResult> {
    const share = input.share ?? "public";
    let payload: unknown;

    if (this.inlineSize(input.site) <= MCP_INLINE_MAX_CHARS) {
      payload = await this.callTool("kailashe_publish", {
        title: input.title,
        slug: input.slug,
        files: input.site.files.map((file) => this.inlineFile(file)),
        share: share === "none" ? false : share,
        operation_key: input.operationKey,
      });
    } else {
      const started = UploadStartSchema.parse(
        await this.callTool("kailashe_upload_start", {
          title: input.title,
          operation_key: `${input.operationKey}:start`,
        }),
      );
      const uploadId = started.versionId ?? started.upload_id ?? started.uploadId;
      if (uploadId === undefined) {
        throw new KailasheComError("kailashe_upload_start did not return an upload id.");
      }
      for (const file of input.site.files) {
        await this.writeFileChunks(uploadId, file);
      }
      payload = await this.callTool("kailashe_publish", {
        title: input.title,
        slug: input.slug,
        upload_id: uploadId,
        share: share === "none" ? false : share,
        operation_key: input.operationKey,
      });
    }

    const parsed = SitePayloadSchema.parse(payload);
    const slug = parsed.site?.slug ?? parsed.slug ?? input.slug;
    const sitePath = parsed.site?.url ?? parsed.url ?? `/s/${slug}`;
    const siteUrl = sitePath.startsWith("http") ? sitePath : `${this.baseUrl}${sitePath}`;
    return {
      slug,
      siteUrl,
      liveUrl: this.liveUrlFor(slug),
      shareUrl: parsed.share?.url ?? parsed.shareUrl ?? null,
      title: parsed.site?.title ?? parsed.title ?? null,
      kind: parsed.site?.kind ?? parsed.kind ?? null,
    };
  }

  /** https://<slug>.<apex> for the platform host (www.kailashe.com → kailashe.com). */
  private liveUrlFor(slug: string): string {
    try {
      const host = new URL(this.baseUrl).hostname;
      const apex = host.startsWith("www.") ? host.slice("www.".length) : host;
      if (apex.includes(".")) return `https://${slug}.${apex}`;
    } catch {
      /* fall through to the site URL */
    }
    return `${this.baseUrl}/s/${slug}`;
  }

  private inlineSize(site: CollectedStaticSite): number {
    let size = 0;
    for (const file of site.files) {
      const encoded = isTextFile(file.path, file.bytes)
        ? file.bytes.byteLength
        : Math.ceil(file.bytes.byteLength / 3) * 4;
      size += encoded + file.path.length + 64;
    }
    return size;
  }

  private inlineFile(file: StaticSiteFile): { path: string; content: string; encoding: "utf8" | "base64" } {
    if (isTextFile(file.path, file.bytes)) {
      return {
        path: file.path,
        content: new TextDecoder("utf-8").decode(file.bytes),
        encoding: "utf8",
      };
    }
    return {
      path: file.path,
      content: Buffer.from(file.bytes).toString("base64"),
      encoding: "base64",
    };
  }

  private async writeFileChunks(uploadId: string, file: StaticSiteFile): Promise<void> {
    if (file.bytes.byteLength === 0) {
      await this.callTool("kailashe_upload_write", {
        upload_id: uploadId,
        path: file.path,
        index: 0,
        base64: "",
        final: true,
      });
      return;
    }
    const chunks = Math.ceil(file.bytes.byteLength / MCP_UPLOAD_CHUNK_BYTES);
    for (let index = 0; index < chunks; index++) {
      const slice = file.bytes.subarray(
        index * MCP_UPLOAD_CHUNK_BYTES,
        (index + 1) * MCP_UPLOAD_CHUNK_BYTES,
      );
      await this.callTool("kailashe_upload_write", {
        upload_id: uploadId,
        path: file.path,
        index,
        base64: Buffer.from(slice).toString("base64"),
        final: index === chunks - 1,
      });
    }
  }

  // -- JSON-RPC plumbing -----------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    try {
      const { response } = await this.rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kailashe-cli", version: "0.1.0" },
      });
      const session = response.headers.get("mcp-session-id");
      if (session !== null && session !== "") this.sessionId = session;
      await this.notify("notifications/initialized").catch(() => undefined);
    } catch (err) {
      if (err instanceof KailasheComAuthError) throw err;
      // Stateless servers may refuse the handshake; tools/call still works.
      this.sessionId = null;
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const { text } = await this.rpc("tools/call", { name, arguments: args });
    const envelope = JsonRpcEnvelopeSchema.parse(this.parseRpcBody(text));
    if (envelope.error !== undefined) {
      throw new KailasheComError(
        envelope.error.message ?? `MCP tool ${name} failed.`,
      );
    }
    if (envelope.result === undefined) {
      throw new KailasheComError(`MCP tool ${name} returned no result.`);
    }
    const tool = ToolResultSchema.parse(envelope.result);
    const textContent = tool.content?.find((c) => c.type === "text")?.text;
    if (tool.isError === true) {
      throw new KailasheComError(
        textContent ?? `MCP tool ${name} reported an error.`,
      );
    }
    if (tool.structuredContent !== undefined) return tool.structuredContent;
    if (textContent !== undefined) {
      try {
        return JSON.parse(textContent) as unknown;
      } catch {
        return { text: textContent };
      }
    }
    return envelope.result;
  }

  private parseRpcBody(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
    // Streamable HTTP may answer with an SSE stream: take the JSON-RPC
    // response event (the last data payload that parses as an envelope).
    let last: unknown = null;
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        last = JSON.parse(data) as unknown;
      } catch {
        /* keep scanning */
      }
    }
    if (last === null) {
      throw new KailasheComError("The platform returned an unreadable MCP response.");
    }
    return last;
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ response: Response; text: string }> {
    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return { response, text: await response.text() };
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId !== null ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new KailasheComError(
        `Could not reach ${this.baseUrl}/mcp: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      const detail = errorMessageFromBody(await response.text().catch(() => ""));
      throw new KailasheComAuthError(
        `kailashe.com refused the token (HTTP ${response.status})${detail !== null ? `: ${detail}` : ""}. ` +
          "Check that KAILASHE_TOKEN holds a valid personal token for this server, then re-run.",
        { httpStatus: response.status },
      );
    }
    if (!response.ok) {
      const detail = errorMessageFromBody(await response.text().catch(() => ""));
      throw new KailasheComError(
        `kailashe.com request failed (HTTP ${response.status})${detail !== null ? `: ${detail}` : ""}.`,
        { httpStatus: response.status },
      );
    }
    return response;
  }
}

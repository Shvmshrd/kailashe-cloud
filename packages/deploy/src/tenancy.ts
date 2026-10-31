/**
 * Tenant subdomain provisioning on the platform domain.
 *
 * A tenant label such as `zi1` maps to `zi1.<platform-domain>` (default
 * `kailashe.tech`). The platform creates a CNAME from that FQDN to the host
 * where the user actually deployed (Modal, Vercel, Cloudflare Workers,
 * ...). DNS writes go through whichever DNS provider hosts the platform
 * zone: Cloudflare (proxied CNAME, Universal SSL) or Vercel DNS
 * (automatic TLS). Either way `https://zi1.abcd.com` works with no
 * certificate step for the user.
 *
 * This module is distinct from `registrar.ts`: it never buys domains. It
 * only manages subdomains inside a zone the platform already owns, plus
 * the instructions shown to users who bring their own domain.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantError";
  }
}

// ---------------------------------------------------------------------------
// Platform domain
// ---------------------------------------------------------------------------

export const DEFAULT_PLATFORM_DOMAIN = "kailashe.tech";

/** Platform domain from `KAILASHE_PLATFORM_DOMAIN`, defaulting to kailashe.tech. */
export function resolvePlatformDomain(env: Record<string, string | undefined> = process.env): string {
  const raw = env.KAILASHE_PLATFORM_DOMAIN;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PLATFORM_DOMAIN;
  return normalizePlatformDomain(raw);
}

function normalizePlatformDomain(domain: string): string {
  if (typeof domain !== "string" || /[\s/?#]/.test(domain.trim()) || domain.includes("://")) {
    throw new TenantError(`invalid platform domain: ${JSON.stringify(domain)} (expected a bare domain like "kailashe.tech")`);
  }
  return normalizeDomainName(domain, "platform domain");
}

// ---------------------------------------------------------------------------
// Subdomain labels
// ---------------------------------------------------------------------------

export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "app",
  "admin",
  "mail",
  "support",
  "help",
  "blog",
  "status",
  "kailashe",
  "root",
  "ns1",
  "ns2",
  "mx",
  "ftp",
  "cdn",
  "auth",
  "login",
  "dashboard",
]);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export type SubdomainLabelValidation = { ok: true; label: string } | { ok: false; reason: string };

export function validateSubdomainLabel(label: string): SubdomainLabelValidation {
  if (typeof label !== "string") return { ok: false, reason: "label must be a string" };
  const normalized = label.trim().toLowerCase();
  if (normalized.length < 2) {
    return { ok: false, reason: "label must be at least 2 characters long" };
  }
  if (normalized.length > 63) {
    return { ok: false, reason: "label must be at most 63 characters long" };
  }
  if (!LABEL_RE.test(normalized)) {
    return {
      ok: false,
      reason: "label must contain only letters, numbers and hyphens, and must start and end with a letter or number",
    };
  }
  if (RESERVED_LABELS.has(normalized)) {
    return { ok: false, reason: `label "${normalized}" is reserved` };
  }
  return { ok: true, label: normalized };
}

// ---------------------------------------------------------------------------
// Hostname / domain / target-host validation (Zod-checked boundaries below
// use these helpers; provision inputs are validated before any side effect)
// ---------------------------------------------------------------------------

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Strip scheme + path/query/fragment, lowercase, drop a trailing dot. */
function stripToHostname(raw: string, what: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TenantError(`${what} is required`);
  }
  let host = raw.trim().toLowerCase();
  const schemeEnd = host.indexOf("://");
  if (schemeEnd !== -1) host = host.slice(schemeEnd + 3);
  host = host.split(/[/?#]/, 1)[0] ?? "";
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") throw new TenantError(`invalid ${what}: ${JSON.stringify(raw)}`);
  if (host.includes("@")) throw new TenantError(`invalid ${what} (userinfo is not allowed): ${JSON.stringify(raw)}`);
  if (host.includes(":")) throw new TenantError(`invalid ${what} (ports are not allowed): ${JSON.stringify(raw)}`);
  return host;
}

function assertValidHostname(host: string, what: string): string {
  if (host.length > 253) throw new TenantError(`invalid ${what}: hostname is too long`);
  if (IPV4_RE.test(host)) throw new TenantError(`invalid ${what}: an IP address cannot be used here, use a hostname`);
  const labels = host.split(".");
  if (labels.length < 2) throw new TenantError(`invalid ${what}: "${host}" must contain a dot (e.g. example.com)`);
  for (const part of labels) {
    if (part.length < 1 || part.length > 63 || !HOST_LABEL_RE.test(part)) {
      throw new TenantError(`invalid ${what}: "${host}" is not a valid hostname`);
    }
  }
  return host;
}

function normalizeDomainName(raw: string, what: string): string {
  return assertValidHostname(stripToHostname(raw, what), what);
}

/** Normalize a deployed host (URL or bare hostname) to a bare hostname. */
export function normalizeTargetHost(raw: string): string {
  return assertValidHostname(stripToHostname(raw, "targetHost"), "targetHost");
}

// ---------------------------------------------------------------------------
// Tenant claims + registry
// ---------------------------------------------------------------------------

export interface TenantClaim {
  label: string;
  fqdn: string;
  userId: string;
  targetHost: string;
  createdAt: string;
  status: "active" | "released";
}

export const TenantClaimSchema = z.object({
  label: z.string().min(1),
  fqdn: z.string().min(1),
  userId: z.string().min(1),
  targetHost: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(["active", "released"]),
});

export interface TenantRegistry {
  getByLabel(label: string): TenantClaim | undefined;
  /** The user's single active claim, if any. */
  getByUser(userId: string): TenantClaim | undefined;
  /**
   * Store a new (or re-activated) claim. Throws TenantError on conflict:
   * a label ever claimed by another user is tombstoned to that user, and a
   * user may hold at most one active label.
   */
  claim(claim: TenantClaim): TenantClaim;
  /** Mark a claim released (tombstone retained). Only the owner may release. */
  release(label: string, userId: string): TenantClaim;
  list(): TenantClaim[];
}

function normalizeClaim(raw: TenantClaim): TenantClaim {
  const checked = validateSubdomainLabel(raw?.label ?? "");
  if (!checked.ok) throw new TenantError(`invalid tenant claim: ${checked.reason}`);
  if (typeof raw.userId !== "string" || raw.userId.trim() === "") {
    throw new TenantError("invalid tenant claim: userId is required");
  }
  if (typeof raw.createdAt !== "string" || raw.createdAt.trim() === "") {
    throw new TenantError("invalid tenant claim: createdAt is required");
  }
  const fqdn = typeof raw.fqdn === "string" ? raw.fqdn.trim().toLowerCase() : "";
  if (!fqdn.startsWith(`${checked.label}.`)) {
    throw new TenantError(`invalid tenant claim: fqdn "${fqdn}" must start with "${checked.label}."`);
  }
  assertValidHostname(fqdn, "fqdn");
  return {
    label: checked.label,
    fqdn,
    userId: raw.userId,
    targetHost: normalizeTargetHost(raw.targetHost),
    createdAt: raw.createdAt,
    status: raw.status,
  };
}

/** Shared uniqueness rules for every registry implementation. */
abstract class BaseTenantRegistry implements TenantRegistry {
  protected claims = new Map<string, TenantClaim>();

  protected persist(): void {
    // In-memory registries have nothing to persist.
  }

  getByLabel(label: string): TenantClaim | undefined {
    if (typeof label !== "string") return undefined;
    const found = this.claims.get(label.trim().toLowerCase());
    return found ? { ...found } : undefined;
  }

  getByUser(userId: string): TenantClaim | undefined {
    for (const claim of this.claims.values()) {
      if (claim.userId === userId && claim.status === "active") return { ...claim };
    }
    return undefined;
  }

  claim(input: TenantClaim): TenantClaim {
    const claim = normalizeClaim(input);
    if (claim.status !== "active") {
      throw new TenantError(`invalid tenant claim: new claims must have status "active"`);
    }
    const existing = this.claims.get(claim.label);
    if (existing) {
      if (existing.userId !== claim.userId) {
        throw new TenantError(
          `subdomain "${claim.label}" (${existing.fqdn}) is already claimed by another user and cannot be claimed again`,
        );
      }
      if (existing.status === "active") {
        throw new TenantError(`subdomain "${claim.label}" (${existing.fqdn}) is already active for this user`);
      }
      // Released tombstone re-claimed by its original owner: allowed below.
    }
    const activeForUser = this.getByUser(claim.userId);
    if (activeForUser && activeForUser.label !== claim.label) {
      throw new TenantError(
        `user already has an active subdomain ${activeForUser.fqdn}; release it before claiming "${claim.label}"`,
      );
    }
    this.claims.set(claim.label, { ...claim });
    this.persist();
    return { ...claim };
  }

  release(label: string, userId: string): TenantClaim {
    const checked = validateSubdomainLabel(label ?? "");
    if (!checked.ok) throw new TenantError(`invalid label: ${checked.reason}`);
    if (typeof userId !== "string" || userId.trim() === "") throw new TenantError("userId is required");
    const existing = this.claims.get(checked.label);
    if (!existing) throw new TenantError(`subdomain "${checked.label}" has not been claimed`);
    if (existing.userId !== userId) {
      throw new TenantError(`subdomain "${checked.label}" (${existing.fqdn}) belongs to another user and cannot be released`);
    }
    if (existing.status === "released") return { ...existing };
    const released: TenantClaim = { ...existing, status: "released" };
    this.claims.set(checked.label, released);
    this.persist();
    return { ...released };
  }

  list(): TenantClaim[] {
    return [...this.claims.values()].map((claim) => ({ ...claim }));
  }
}

export class InMemoryTenantRegistry extends BaseTenantRegistry {}

const TenantRegistryFileSchema = z.object({
  version: z.literal(1),
  claims: z.array(TenantClaimSchema),
});

export class FileTenantRegistry extends BaseTenantRegistry {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new TenantError("FileTenantRegistry: filePath is required");
    }
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      throw new TenantError(
        `tenant registry at ${this.filePath} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      throw new TenantError(`tenant registry at ${this.filePath} is corrupt (invalid JSON); refusing to overwrite it`);
    }
    const parsed = TenantRegistryFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new TenantError(`tenant registry at ${this.filePath} is corrupt (${issues}); refusing to overwrite it`);
    }
    for (const claim of parsed.data.claims) {
      const key = claim.label.trim().toLowerCase();
      if (this.claims.has(key)) {
        throw new TenantError(`tenant registry at ${this.filePath} is corrupt (duplicate label "${key}")`);
      }
      this.claims.set(key, { ...claim, label: key });
    }
  }

  protected override persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: 1, claims: [...this.claims.values()] }, null, 2);
    writeFileSync(tmpPath, `${payload}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// DNS providers
// ---------------------------------------------------------------------------

export interface UpsertSubdomainRecordInput {
  label: string;
  fqdn: string;
  targetHost: string;
  proxied: boolean;
}

export interface DeleteSubdomainRecordInput {
  label: string;
  fqdn: string;
}

export type TenantHttpsMode = "cloudflare-proxied" | "vercel-automatic";

export interface DnsProvider {
  /**
   * How HTTPS is provided for claimed subdomains. Cloudflare-proxied zones
   * terminate TLS via Universal SSL; Vercel DNS zones get automatic TLS
   * from Vercel. Absent = "cloudflare-proxied".
   */
  readonly httpsMode?: TenantHttpsMode;
  upsertSubdomainRecord(input: UpsertSubdomainRecordInput): Promise<{ recordId: string }>;
  deleteSubdomainRecord(input: DeleteSubdomainRecordInput): Promise<void>;
}

export interface FakeDnsRecord extends UpsertSubdomainRecordInput {
  recordId: string;
}

export class FakeDnsProvider implements DnsProvider {
  readonly records = new Map<string, FakeDnsRecord>();
  shouldFail = false;
  private nextId = 1;

  /** When enabled, every DNS operation throws (simulated provider outage). */
  setFailing(fail: boolean): void {
    this.shouldFail = fail;
  }

  async upsertSubdomainRecord(input: UpsertSubdomainRecordInput): Promise<{ recordId: string }> {
    if (this.shouldFail) throw new TenantError("FakeDnsProvider: simulated DNS failure");
    const existing = this.records.get(input.fqdn);
    const recordId = existing?.recordId ?? `fake-${this.nextId++}`;
    this.records.set(input.fqdn, { ...input, recordId });
    return { recordId };
  }

  async deleteSubdomainRecord(input: DeleteSubdomainRecordInput): Promise<void> {
    if (this.shouldFail) throw new TenantError("FakeDnsProvider: simulated DNS failure");
    this.records.delete(input.fqdn);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare DNS provider
// ---------------------------------------------------------------------------

export interface CloudflareDnsProviderOptions {
  /** Cloudflare API token. Supplied by the caller only; never logged here. */
  apiToken: string;
  zoneId: string;
  platformDomain: string;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
}

const CloudflareRecordSchema = z.object({ id: z.string().min(1) }).passthrough();
const CloudflareListResponseSchema = z.object({
  success: z.boolean().optional(),
  result: z.array(CloudflareRecordSchema).optional(),
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
}).passthrough();
const CloudflareSingleResponseSchema = z.object({
  success: z.boolean().optional(),
  result: CloudflareRecordSchema.optional(),
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
}).passthrough();

export class CloudflareDnsProvider implements DnsProvider {
  private readonly apiToken: string;
  private readonly zoneId: string;
  private readonly platformDomain: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(opts: CloudflareDnsProviderOptions) {
    if (!opts.apiToken) throw new TenantError("CloudflareDnsProvider: apiToken is required");
    if (!opts.zoneId) throw new TenantError("CloudflareDnsProvider: zoneId is required");
    this.apiToken = opts.apiToken;
    this.zoneId = opts.zoneId;
    this.platformDomain = normalizePlatformDomain(opts.platformDomain);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  }

  async upsertSubdomainRecord(input: UpsertSubdomainRecordInput): Promise<{ recordId: string }> {
    const checked = validateSubdomainLabel(input.label);
    if (!checked.ok) throw new TenantError(`invalid label: ${checked.reason}`);
    const fqdn = normalizeDomainName(input.fqdn, "fqdn");
    if (fqdn !== `${checked.label}.${this.platformDomain}`) {
      throw new TenantError(`fqdn "${fqdn}" does not match label "${checked.label}" on ${this.platformDomain}`);
    }
    const targetHost = normalizeTargetHost(input.targetHost);
    const body = { type: "CNAME", name: fqdn, content: targetHost, proxied: true, ttl: 1 };

    const existingId = await this.findRecordId(fqdn);
    const url = existingId
      ? `${this.apiBaseUrl}/zones/${encodeURIComponent(this.zoneId)}/dns_records/${encodeURIComponent(existingId)}`
      : `${this.apiBaseUrl}/zones/${encodeURIComponent(this.zoneId)}/dns_records`;
    const res = await this.request(url, { method: existingId ? "PUT" : "POST", body: JSON.stringify(body) });
    const data = await this.parseJson(res, CloudflareSingleResponseSchema, `upsert DNS record for ${fqdn}`);
    if (!res.ok || data.success === false || !data.result) {
      throw new TenantError(`Cloudflare DNS upsert failed for ${fqdn}: ${res.status} ${res.statusText}${errorDetail(data.errors)}`);
    }
    return { recordId: data.result.id };
  }

  async deleteSubdomainRecord(input: DeleteSubdomainRecordInput): Promise<void> {
    const fqdn = normalizeDomainName(input.fqdn, "fqdn");
    const existingId = await this.findRecordId(fqdn);
    if (!existingId) return;
    const url = `${this.apiBaseUrl}/zones/${encodeURIComponent(this.zoneId)}/dns_records/${encodeURIComponent(existingId)}`;
    const res = await this.request(url, { method: "DELETE" });
    if (!res.ok) {
      throw new TenantError(`Cloudflare DNS delete failed for ${fqdn}: ${res.status} ${res.statusText}`);
    }
  }

  private async findRecordId(fqdn: string): Promise<string | undefined> {
    const url =
      `${this.apiBaseUrl}/zones/${encodeURIComponent(this.zoneId)}/dns_records` +
      `?type=CNAME&name=${encodeURIComponent(fqdn)}`;
    const res = await this.request(url, { method: "GET" });
    const data = await this.parseJson(res, CloudflareListResponseSchema, `look up DNS record for ${fqdn}`);
    if (!res.ok || data.success === false) {
      throw new TenantError(`Cloudflare DNS lookup failed for ${fqdn}: ${res.status} ${res.statusText}${errorDetail(data.errors)}`);
    }
    return data.result?.[0]?.id;
  }

  private async request(url: string, init: { method: string; body?: string }): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: init.method,
        headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      // Deliberately exclude headers/credentials from every error path.
      throw new TenantError(`Cloudflare DNS request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async parseJson<T>(
    res: Response,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> {
    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      throw new TenantError(`Cloudflare DNS response for ${what} was not valid JSON: ${res.status} ${res.statusText}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TenantError(`Cloudflare DNS response for ${what} had an unexpected shape: ${res.status} ${res.statusText}`);
    }
    return parsed.data;
  }
}

function errorDetail(errors: ReadonlyArray<{ message?: string }> | undefined): string {
  const messages = (errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === "string" && m !== "");
  return messages.length > 0 ? ` (${messages.join("; ")})` : "";
}

// ---------------------------------------------------------------------------
// Vercel DNS provider (alternative to Cloudflare when the platform zone's
// nameservers are hosted by Vercel)
// ---------------------------------------------------------------------------

export interface VercelDnsProviderOptions {
  /** Vercel API token. Supplied by the caller only; never logged here. */
  apiToken: string;
  /** The platform domain, which must be a domain using Vercel DNS. */
  platformDomain: string;
  /** Optional Vercel team id (sent as the `teamId` query parameter). */
  teamId?: string;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
}

const VercelRecordSchema = z.object({ id: z.string().min(1) }).passthrough();
const VercelListResponseSchema = z.object({
  records: z.array(VercelRecordSchema).optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();
const VercelCreateResponseSchema = z.object({
  id: z.string().min(1).optional(),
  uid: z.string().min(1).optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export class VercelDnsProvider implements DnsProvider {
  readonly httpsMode = "vercel-automatic" as const;

  private readonly apiToken: string;
  private readonly platformDomain: string;
  private readonly teamId: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(opts: VercelDnsProviderOptions) {
    if (!opts.apiToken) throw new TenantError("VercelDnsProvider: apiToken is required");
    this.apiToken = opts.apiToken;
    this.platformDomain = normalizePlatformDomain(opts.platformDomain);
    this.teamId = opts.teamId;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.vercel.com").replace(/\/+$/, "");
  }

  async upsertSubdomainRecord(input: UpsertSubdomainRecordInput): Promise<{ recordId: string }> {
    const checked = validateSubdomainLabel(input.label);
    if (!checked.ok) throw new TenantError(`invalid label: ${checked.reason}`);
    const fqdn = normalizeDomainName(input.fqdn, "fqdn");
    if (fqdn !== `${checked.label}.${this.platformDomain}`) {
      throw new TenantError(`fqdn "${fqdn}" does not match label "${checked.label}" on ${this.platformDomain}`);
    }
    const targetHost = normalizeTargetHost(input.targetHost);

    // Vercel has no update endpoint for DNS records: keep an identical
    // record, otherwise delete the stale one and create a fresh record.
    const existing = await this.findRecord(checked.label);
    if (existing) {
      if (existing.value === targetHost) return { recordId: existing.id };
      await this.deleteRecordById(existing.id, fqdn);
    }

    const url = this.recordsUrl("v2");
    const body = { name: checked.label, type: "CNAME", value: targetHost, ttl: 60 };
    const res = await this.request(url, { method: "POST", body: JSON.stringify(body) });
    const data = await this.parseJson(res, VercelCreateResponseSchema, `upsert DNS record for ${fqdn}`);
    const recordId = data.id ?? data.uid;
    if (!res.ok || data.error || !recordId) {
      throw new TenantError(`Vercel DNS upsert failed for ${fqdn}: ${res.status} ${res.statusText}${vercelErrorDetail(data.error?.message)}`);
    }
    return { recordId };
  }

  async deleteSubdomainRecord(input: DeleteSubdomainRecordInput): Promise<void> {
    const checked = validateSubdomainLabel(input.label);
    if (!checked.ok) throw new TenantError(`invalid label: ${checked.reason}`);
    const fqdn = normalizeDomainName(input.fqdn, "fqdn");
    const existing = await this.findRecord(checked.label);
    if (!existing) return;
    await this.deleteRecordById(existing.id, fqdn);
  }

  private recordsUrl(version: "v2" | "v4"): string {
    const base = `${this.apiBaseUrl}/${version}/domains/${encodeURIComponent(this.platformDomain)}/records`;
    return this.teamId ? `${base}?teamId=${encodeURIComponent(this.teamId)}` : base;
  }

  private recordUrl(recordId: string): string {
    const base = `${this.apiBaseUrl}/v2/domains/${encodeURIComponent(this.platformDomain)}/records/${encodeURIComponent(recordId)}`;
    return this.teamId ? `${base}?teamId=${encodeURIComponent(this.teamId)}` : base;
  }

  private async findRecord(label: string): Promise<{ id: string; value?: string } | undefined> {
    const res = await this.request(this.recordsUrl("v4"), { method: "GET" });
    const data = await this.parseJson(res, VercelListResponseSchema, `look up DNS record for ${label}.${this.platformDomain}`);
    if (!res.ok || data.error) {
      throw new TenantError(
        `Vercel DNS lookup failed for ${label}.${this.platformDomain}: ${res.status} ${res.statusText}${vercelErrorDetail(data.error?.message)}`,
      );
    }
    for (const record of data.records ?? []) {
      const r = record as { id: string; name?: unknown; type?: unknown; value?: unknown };
      if (r.name === label && r.type === "CNAME") {
        return { id: r.id, value: typeof r.value === "string" ? r.value : undefined };
      }
    }
    return undefined;
  }

  private async deleteRecordById(recordId: string, fqdn: string): Promise<void> {
    const res = await this.request(this.recordUrl(recordId), { method: "DELETE" });
    if (!res.ok) {
      throw new TenantError(`Vercel DNS delete failed for ${fqdn}: ${res.status} ${res.statusText}`);
    }
  }

  private async request(url: string, init: { method: string; body?: string }): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: init.method,
        headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      // Deliberately exclude headers/credentials from every error path.
      throw new TenantError(`Vercel DNS request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async parseJson<T>(
    res: Response,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> {
    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      throw new TenantError(`Vercel DNS response for ${what} was not valid JSON: ${res.status} ${res.statusText}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TenantError(`Vercel DNS response for ${what} had an unexpected shape: ${res.status} ${res.statusText}`);
    }
    return parsed.data;
  }
}

function vercelErrorDetail(message: string | undefined): string {
  return typeof message === "string" && message !== "" ? ` (${message})` : "";
}

// ---------------------------------------------------------------------------
// Provision / release
// ---------------------------------------------------------------------------

export interface ProvisionSubdomainInput {
  userId: string;
  label: string;
  targetHost: string;
  registry: TenantRegistry;
  dns: DnsProvider;
  platformDomain?: string;
  now?: Date | string;
}

export interface ProvisionSubdomainResult {
  label: string;
  fqdn: string;
  url: string;
  targetHost: string;
  https: { enabled: true; mode: TenantHttpsMode; note: string };
  recordId: string;
}

export async function provisionSubdomain(input: ProvisionSubdomainInput): Promise<ProvisionSubdomainResult> {
  if (typeof input.userId !== "string" || input.userId.trim() === "") {
    throw new TenantError("userId is required");
  }
  const platformDomain = input.platformDomain !== undefined
    ? normalizePlatformDomain(input.platformDomain)
    : resolvePlatformDomain();
  const checked = validateSubdomainLabel(input.label);
  if (!checked.ok) throw new TenantError(`invalid subdomain label: ${checked.reason}`);
  const label = checked.label;
  const targetHost = normalizeTargetHost(input.targetHost);
  const fqdn = `${label}.${platformDomain}`;
  const createdAt = resolveNow(input.now);

  // Claim first so uniqueness is decided before any DNS side effect; if
  // the DNS upsert then fails, the claim is released (tombstone retained)
  // and the original DNS error is rethrown.
  input.registry.claim({ label, fqdn, userId: input.userId, targetHost, createdAt, status: "active" });

  let recordId: string;
  try {
    const upserted = await input.dns.upsertSubdomainRecord({ label, fqdn, targetHost, proxied: true });
    recordId = upserted.recordId;
  } catch (err) {
    try {
      input.registry.release(label, input.userId);
    } catch {
      // Rollback is best-effort; the DNS error below is the one to surface.
    }
    throw err;
  }

  const httpsMode: TenantHttpsMode = input.dns.httpsMode ?? "cloudflare-proxied";
  return {
    label,
    fqdn,
    url: `https://${fqdn}`,
    targetHost,
    https: {
      enabled: true,
      mode: httpsMode,
      note: httpsNoteFor(httpsMode, fqdn, platformDomain),
    },
    recordId,
  };
}

function httpsNoteFor(mode: TenantHttpsMode, fqdn: string, platformDomain: string): string {
  if (mode === "vercel-automatic") {
    return `HTTPS is automatic: ${fqdn} resolves through Vercel DNS and Vercel provisions a TLS certificate for it automatically once DNS propagates.`;
  }
  return `HTTPS is automatic: ${fqdn} is proxied through Cloudflare (orange cloud) and covered by Universal SSL for *.${platformDomain}.`;
}

function resolveNow(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) throw new TenantError("now must be a valid date");
    return now.toISOString();
  }
  const parsed = new Date(now);
  if (typeof now !== "string" || now.trim() === "" || Number.isNaN(parsed.getTime())) {
    throw new TenantError("now must be a valid ISO date string");
  }
  return parsed.toISOString();
}

export interface ReleaseSubdomainInput {
  userId: string;
  label: string;
  registry: TenantRegistry;
  dns: DnsProvider;
}

export interface ReleaseSubdomainResult {
  label: string;
  fqdn: string;
  status: "released";
}

export async function releaseSubdomain(input: ReleaseSubdomainInput): Promise<ReleaseSubdomainResult> {
  if (typeof input.userId !== "string" || input.userId.trim() === "") {
    throw new TenantError("userId is required");
  }
  const checked = validateSubdomainLabel(input.label);
  if (!checked.ok) throw new TenantError(`invalid subdomain label: ${checked.reason}`);
  const existing = input.registry.getByLabel(checked.label);
  if (!existing) throw new TenantError(`subdomain "${checked.label}" has not been claimed`);
  if (existing.userId !== input.userId) {
    throw new TenantError(`subdomain "${checked.label}" (${existing.fqdn}) belongs to another user and cannot be released`);
  }
  // DNS first: if deletion fails the claim stays active and retryable.
  await input.dns.deleteSubdomainRecord({ label: checked.label, fqdn: existing.fqdn });
  const released = input.registry.release(checked.label, input.userId);
  return { label: released.label, fqdn: released.fqdn, status: "released" };
}

// ---------------------------------------------------------------------------
// Custom (bring-your-own) domains
// ---------------------------------------------------------------------------

export interface CustomDnsRecord {
  type: "CNAME";
  name: string;
  value: string;
  proxied: "recommended";
  ttl: "auto";
}

export interface CustomDomainSettings {
  domain: string;
  records: CustomDnsRecord[];
  steps: string[];
  httpsNote: string;
}

export function customDomainSettings(input: {
  domain: string;
  targetHost: string;
  platformDomain?: string;
}): CustomDomainSettings {
  const platformDomain = input.platformDomain !== undefined
    ? normalizePlatformDomain(input.platformDomain)
    : resolvePlatformDomain();
  const domain = normalizeDomainName(input.domain, "domain");
  if (domain === platformDomain || domain.endsWith(`.${platformDomain}`)) {
    throw new TenantError(
      `"${domain}" is on the platform domain ${platformDomain}; claim that subdomain instead of configuring a custom domain`,
    );
  }
  const targetHost = normalizeTargetHost(input.targetHost);
  const records: CustomDnsRecord[] = [
    { type: "CNAME", name: "@", value: targetHost, proxied: "recommended", ttl: "auto" },
    { type: "CNAME", name: "www", value: targetHost, proxied: "recommended", ttl: "auto" },
  ];
  return {
    domain,
    records,
    steps: [
      `In your DNS provider for ${domain}, add a CNAME record: name "@" (the root/apex) pointing to ${targetHost}. If your provider does not allow a CNAME at the apex, use its ALIAS/ANAME or flattening option with the same value.`,
      `Add a second CNAME record: name "www" pointing to ${targetHost}, so www.${domain} works too.`,
      `Set both records' TTL to auto, and if you use Cloudflare, proxy them (orange cloud) so HTTPS is terminated for you.`,
      `Register ${domain} and www.${domain} with your hosting provider, in the app's custom-domain settings. Providers only answer for names they know about: without this step the DNS resolves but the host returns 404 (verified against Modal) and issues no certificate for your domain. Kailashe does not do this step for you — it is yours to complete in the provider's dashboard.`,
      `Wait for DNS propagation (usually a few minutes), then visit https://${domain} to confirm your deployment answers.`,
    ],
    httpsNote:
      "HTTPS is not issued by Kailashe for custom domains: proxy the records through Cloudflare (orange cloud) " +
      "for automatic Universal SSL, or enable HTTPS at your hosting provider for " +
      `${domain} and www.${domain}. Registering the domain with your provider (the step above) is ` +
      "usually what makes the provider issue that certificate.",
  };
}

// ---------------------------------------------------------------------------
// Onboarding decision (pure; drives the CLI prompt flow)
// ---------------------------------------------------------------------------

export type DomainOnboardingResult =
  | { kind: "custom"; settings: CustomDomainSettings }
  | { kind: "platform"; label: string; fqdn: string; url: string }
  | { kind: "needs-label" };

export function resolveDomainOnboarding(input: {
  hasOwnDomain: boolean;
  ownDomain?: string;
  label?: string;
  targetHost: string;
  platformDomain?: string;
}): DomainOnboardingResult {
  const platformDomain = input.platformDomain !== undefined
    ? normalizePlatformDomain(input.platformDomain)
    : resolvePlatformDomain();

  if (input.hasOwnDomain) {
    const settings = customDomainSettings({
      domain: input.ownDomain ?? "",
      targetHost: input.targetHost,
      platformDomain,
    });
    return { kind: "custom", settings };
  }

  if (input.label === undefined || input.label.trim() === "") {
    return { kind: "needs-label" };
  }
  const checked = validateSubdomainLabel(input.label);
  if (!checked.ok) throw new TenantError(`invalid subdomain label: ${checked.reason}`);
  const fqdn = `${checked.label}.${platformDomain}`;
  return { kind: "platform", label: checked.label, fqdn, url: `https://${fqdn}` };
}

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflareDnsProvider,
  DEFAULT_PLATFORM_DOMAIN,
  FakeDnsProvider,
  FileTenantRegistry,
  InMemoryTenantRegistry,
  RESERVED_LABELS,
  TenantError,
  VercelDnsProvider,
  customDomainSettings,
  provisionSubdomain,
  releaseSubdomain,
  resolveDomainOnboarding,
  resolvePlatformDomain,
  validateSubdomainLabel,
  type TenantClaim,
} from "../src/tenancy.js";

const NOW = "2026-10-29T00:00:00.000Z";
const TARGET = "zi1-app.modal.run";

function makeClaim(overrides: Partial<TenantClaim> = {}): TenantClaim {
  return {
    label: "zi1",
    fqdn: "zi1.kailashe.tech",
    userId: "user-a",
    targetHost: TARGET,
    createdAt: NOW,
    status: "active",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Platform domain + labels
// ---------------------------------------------------------------------------

describe("platform domain", () => {
  it("defaults to kailashe.tech", () => {
    expect(DEFAULT_PLATFORM_DOMAIN).toBe("kailashe.tech");
    expect(resolvePlatformDomain({})).toBe("kailashe.tech");
    expect(resolvePlatformDomain({ KAILASHE_PLATFORM_DOMAIN: "" })).toBe("kailashe.tech");
  });

  it("reads, lowercases and validates the env value", () => {
    expect(resolvePlatformDomain({ KAILASHE_PLATFORM_DOMAIN: "Example.COM" })).toBe("example.com");
    expect(() => resolvePlatformDomain({ KAILASHE_PLATFORM_DOMAIN: "not a domain" })).toThrow(TenantError);
    expect(() => resolvePlatformDomain({ KAILASHE_PLATFORM_DOMAIN: "https://x.com/path" })).toThrow(TenantError);
  });
});

describe("validateSubdomainLabel", () => {
  it("accepts and lowercases valid labels", () => {
    expect(validateSubdomainLabel("zi1")).toEqual({ ok: true, label: "zi1" });
    expect(validateSubdomainLabel("ZI1")).toEqual({ ok: true, label: "zi1" });
    expect(validateSubdomainLabel("my-app2")).toEqual({ ok: true, label: "my-app2" });
  });

  it("rejects reserved, malformed and out-of-range labels", () => {
    for (const reserved of ["www", "api", "admin", "dashboard"]) {
      expect(RESERVED_LABELS.has(reserved)).toBe(true);
      const result = validateSubdomainLabel(reserved);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/reserved/);
    }
    expect(validateSubdomainLabel("bad_label!").ok).toBe(false);
    expect(validateSubdomainLabel("-leading").ok).toBe(false);
    expect(validateSubdomainLabel("trailing-").ok).toBe(false);
    expect(validateSubdomainLabel("a").ok).toBe(false);
    expect(validateSubdomainLabel("").ok).toBe(false);
    expect(validateSubdomainLabel("x".repeat(64)).ok).toBe(false);
    expect(validateSubdomainLabel("has space").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provisioning happy path + uniqueness
// ---------------------------------------------------------------------------

describe("provisionSubdomain", () => {
  it("provisions zi1 -> https://zi1.kailashe.tech via proxied CNAME", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    const result = await provisionSubdomain({
      userId: "user-a",
      label: "zi1",
      targetHost: "https://zi1-app.modal.run/some/path/",
      registry,
      dns,
      now: NOW,
    });
    expect(result).toMatchObject({
      label: "zi1",
      fqdn: "zi1.kailashe.tech",
      url: "https://zi1.kailashe.tech",
      targetHost: TARGET,
    });
    expect(result.https.enabled).toBe(true);
    expect(result.https.mode).toBe("cloudflare-proxied");
    expect(result.https.note).toContain("*.kailashe.tech");
    expect(result.recordId).toBeTruthy();
    expect(dns.records.get("zi1.kailashe.tech")).toMatchObject({ targetHost: TARGET, proxied: true });
    expect(registry.getByUser("user-a")).toMatchObject({ label: "zi1", status: "active", createdAt: NOW });
  });

  it("honours a custom platform domain", async () => {
    const registry = new InMemoryTenantRegistry();
    const result = await provisionSubdomain({
      userId: "user-a",
      label: "Zi1",
      targetHost: TARGET,
      registry,
      dns: new FakeDnsProvider(),
      platformDomain: "Example.ORG",
    });
    expect(result.fqdn).toBe("zi1.example.org");
    expect(result.url).toBe("https://zi1.example.org");
  });

  it("rejects a duplicate label claimed by another user", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    await provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry, dns });
    await expect(
      provisionSubdomain({ userId: "user-b", label: "zi1", targetHost: "other.vercel.app", registry, dns }),
    ).rejects.toThrow(TenantError);
    await expect(
      provisionSubdomain({ userId: "user-b", label: "ZI1", targetHost: "other.vercel.app", registry, dns }),
    ).rejects.toThrow(/already claimed/);
  });

  it("rejects a second active label for the same user, naming their current fqdn", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    await provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry, dns });
    await expect(
      provisionSubdomain({ userId: "user-a", label: "zi2", targetHost: TARGET, registry, dns }),
    ).rejects.toThrow(/zi1\.kailashe\.tech/);
    expect(dns.records.has("zi2.kailashe.tech")).toBe(false);
  });

  it("rejects invalid labels and invalid target hosts before any side effect", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    await expect(
      provisionSubdomain({ userId: "user-a", label: "www", targetHost: TARGET, registry, dns }),
    ).rejects.toThrow(/reserved/);
    await expect(
      provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: "not a host", registry, dns }),
    ).rejects.toThrow(TenantError);
    await expect(
      provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: "https://1.2.3.4/x", registry, dns }),
    ).rejects.toThrow(TenantError);
    expect(registry.list()).toEqual([]);
    expect(dns.records.size).toBe(0);
  });

  it("rolls back the claim when DNS fails, and the owner can retry", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    dns.setFailing(true);
    await expect(
      provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry, dns }),
    ).rejects.toThrow(/simulated DNS failure/);
    expect(registry.getByUser("user-a")).toBeUndefined();
    expect(registry.getByLabel("zi1")).toMatchObject({ status: "released", userId: "user-a" });

    dns.setFailing(false);
    const retry = await provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry, dns });
    expect(retry.url).toBe("https://zi1.kailashe.tech");
    expect(registry.getByUser("user-a")).toMatchObject({ label: "zi1", status: "active" });
  });
});

// ---------------------------------------------------------------------------
// Release + tombstones
// ---------------------------------------------------------------------------

describe("releaseSubdomain and tombstones", () => {
  it("only the owner can release; DNS is deleted and the tombstone blocks others", async () => {
    const registry = new InMemoryTenantRegistry();
    const dns = new FakeDnsProvider();
    await provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry, dns });

    await expect(releaseSubdomain({ userId: "user-b", label: "zi1", registry, dns })).rejects.toThrow(TenantError);
    expect(dns.records.has("zi1.kailashe.tech")).toBe(true);
    expect(registry.getByUser("user-a")).toBeDefined();

    const released = await releaseSubdomain({ userId: "user-a", label: "zi1", registry, dns });
    expect(released).toEqual({ label: "zi1", fqdn: "zi1.kailashe.tech", status: "released" });
    expect(dns.records.has("zi1.kailashe.tech")).toBe(false);
    expect(registry.getByUser("user-a")).toBeUndefined();
    expect(registry.getByLabel("zi1")).toMatchObject({ status: "released", userId: "user-a" });

    // Tombstone: another user can never take the released label...
    await expect(
      provisionSubdomain({ userId: "user-b", label: "zi1", targetHost: "other.vercel.app", registry, dns }),
    ).rejects.toThrow(/already claimed/);

    // ...but the original owner can re-claim it.
    const reclaimed = await provisionSubdomain({
      userId: "user-a",
      label: "zi1",
      targetHost: "new-host.modal.run",
      registry,
      dns,
    });
    expect(reclaimed.url).toBe("https://zi1.kailashe.tech");
    expect(registry.getByUser("user-a")).toMatchObject({ targetHost: "new-host.modal.run", status: "active" });
  });

  it("registry-level claim/release enforces the same rules", () => {
    const registry = new InMemoryTenantRegistry();
    registry.claim(makeClaim());
    expect(() => registry.claim(makeClaim({ userId: "user-b", fqdn: "zi1.kailashe.tech" }))).toThrow(TenantError);
    expect(() => registry.release("zi1", "user-b")).toThrow(/another user/);
    registry.release("zi1", "user-a");
    expect(() => registry.claim(makeClaim({ userId: "user-b" }))).toThrow(TenantError);
    expect(registry.claim(makeClaim({ createdAt: "2026-10-30T00:00:00.000Z" })).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// File registry
// ---------------------------------------------------------------------------

describe("FileTenantRegistry", () => {
  it("persists claims across instances, creating directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kailashe-tenancy-"));
    const file = join(dir, "nested", "tenants.json");
    const dns = new FakeDnsProvider();

    const first = new FileTenantRegistry(file);
    await provisionSubdomain({ userId: "user-a", label: "zi1", targetHost: TARGET, registry: first, dns, now: NOW });
    expect(existsSync(file)).toBe(true);

    const second = new FileTenantRegistry(file);
    expect(second.getByLabel("zi1")).toEqual(makeClaim());
    expect(second.getByUser("user-a")).toMatchObject({ label: "zi1" });
    expect(second.list()).toHaveLength(1);

    await releaseSubdomain({ userId: "user-a", label: "zi1", registry: second, dns });
    const third = new FileTenantRegistry(file);
    expect(third.getByLabel("zi1")).toMatchObject({ status: "released" });
  });

  it("throws on a corrupt file instead of wiping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kailashe-tenancy-"));
    const file = join(dir, "tenants.json");
    writeFileSync(file, "{not json", "utf8");
    expect(() => new FileTenantRegistry(file)).toThrow(TenantError);
    expect(readFileSync(file, "utf8")).toBe("{not json");

    writeFileSync(file, JSON.stringify({ version: 1, claims: [{ label: "zi1" }] }), "utf8");
    expect(() => new FileTenantRegistry(file)).toThrow(/corrupt/);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare DNS provider (mocked fetch, no network)
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeCloudflareFetch(opts: { existingId?: string; failStatus?: number } = {}): {
  fetchFn: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (opts.failStatus) {
      return {
        ok: false,
        status: opts.failStatus,
        statusText: "Forbidden",
        json: async () => ({ success: false, errors: [{ message: "bad token" }] }),
      } as unknown as Response;
    }
    if ((init?.method ?? "GET") === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ success: true, result: opts.existingId ? [{ id: opts.existingId }] : [] }),
      } as unknown as Response;
    }
    if (init?.method === "DELETE") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ success: true, result: { id: opts.existingId } }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ success: true, result: { id: opts.existingId ?? "rec-new" } }),
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

describe("CloudflareDnsProvider", () => {
  const SECRET = "cf-secret-token-value";

  it("creates a proxied CNAME via POST with the bearer token", async () => {
    const { fetchFn, calls } = makeCloudflareFetch();
    const dns = new CloudflareDnsProvider({ apiToken: SECRET, zoneId: "zone-1", platformDomain: "kailashe.tech", fetchFn });
    const provisioned = await provisionSubdomain({
      userId: "user-a",
      label: "zi1",
      targetHost: TARGET,
      registry: new InMemoryTenantRegistry(),
      dns,
    });
    expect(provisioned.recordId).toBe("rec-new");

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/dns_records");
    expect(post?.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(post?.body).toEqual({ type: "CNAME", name: "zi1.kailashe.tech", content: TARGET, proxied: true, ttl: 1 });
    const lookup = calls.find((c) => c.method === "GET");
    expect(lookup?.url).toContain("type=CNAME");
    expect(lookup?.url).toContain(encodeURIComponent("zi1.kailashe.tech"));
  });

  it("updates via PUT when the record already exists, and deletes by id", async () => {
    const { fetchFn, calls } = makeCloudflareFetch({ existingId: "rec-9" });
    const dns = new CloudflareDnsProvider({ apiToken: SECRET, zoneId: "zone-1", platformDomain: "kailashe.tech", fetchFn });
    const { recordId } = await dns.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true });
    expect(recordId).toBe("rec-9");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/rec-9");

    await dns.deleteSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech" });
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/rec-9");
  });

  it("never leaks the token in thrown errors", async () => {
    const { fetchFn } = makeCloudflareFetch({ failStatus: 403 });
    const dns = new CloudflareDnsProvider({ apiToken: SECRET, zoneId: "zone-1", platformDomain: "kailashe.tech", fetchFn });
    const err = await dns
      .upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantError);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).toContain("403");
  });

  it("requires token and zone, and validates the fqdn against the platform domain", async () => {
    expect(() => new CloudflareDnsProvider({ apiToken: "", zoneId: "z", platformDomain: "kailashe.tech" })).toThrow(TenantError);
    expect(() => new CloudflareDnsProvider({ apiToken: "t", zoneId: "", platformDomain: "kailashe.tech" })).toThrow(TenantError);
    const { fetchFn } = makeCloudflareFetch();
    const dns = new CloudflareDnsProvider({ apiToken: SECRET, zoneId: "zone-1", platformDomain: "kailashe.tech", fetchFn });
    await expect(
      dns.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.elsewhere.com", targetHost: TARGET, proxied: true }),
    ).rejects.toThrow(TenantError);
  });
});

// ---------------------------------------------------------------------------
// Custom domains + onboarding
// ---------------------------------------------------------------------------

describe("customDomainSettings", () => {
  it("returns apex + www CNAME records to the target host", () => {
    const settings = customDomainSettings({ domain: "https://MySite.com/", targetHost: "https://app.vercel.app/x" });
    expect(settings.domain).toBe("mysite.com");
    expect(settings.records).toEqual([
      { type: "CNAME", name: "@", value: "app.vercel.app", proxied: "recommended", ttl: "auto" },
      { type: "CNAME", name: "www", value: "app.vercel.app", proxied: "recommended", ttl: "auto" },
    ]);
    expect(settings.steps.length).toBeGreaterThan(0);
    expect(settings.steps.join(" ")).toContain("app.vercel.app");
    // The manual-domain decision: Kailashe prints DNS records only; the user
    // must also register the domain with the host or it 404s (Modal-verified).
    expect(settings.steps.join(" ")).toContain("Register mysite.com and www.mysite.com with your hosting provider");
    expect(settings.httpsNote).toMatch(/HTTPS/);
  });

  it("rejects platform-domain names (that is the claim path)", () => {
    expect(() => customDomainSettings({ domain: "zi1.kailashe.tech", targetHost: TARGET })).toThrow(/claim/);
    expect(() => customDomainSettings({ domain: "kailashe.tech", targetHost: TARGET })).toThrow(TenantError);
    expect(() => customDomainSettings({ domain: "bad domain", targetHost: TARGET })).toThrow(TenantError);
  });
});

describe("resolveDomainOnboarding", () => {
  it("routes own-domain users to custom settings", () => {
    const result = resolveDomainOnboarding({ hasOwnDomain: true, ownDomain: "mysite.com", targetHost: TARGET });
    expect(result.kind).toBe("custom");
    if (result.kind === "custom") expect(result.settings.records[0]?.value).toBe(TARGET);
  });

  it("routes platform users with a label to their fqdn and url", () => {
    expect(resolveDomainOnboarding({ hasOwnDomain: false, label: "ZI1", targetHost: TARGET })).toEqual({
      kind: "platform",
      label: "zi1",
      fqdn: "zi1.kailashe.tech",
      url: "https://zi1.kailashe.tech",
    });
  });

  it("asks for a label when platform users have not chosen one", () => {
    expect(resolveDomainOnboarding({ hasOwnDomain: false, targetHost: TARGET })).toEqual({ kind: "needs-label" });
    expect(resolveDomainOnboarding({ hasOwnDomain: false, label: "  ", targetHost: TARGET })).toEqual({
      kind: "needs-label",
    });
  });

  it("throws on an invalid label instead of silently routing", () => {
    expect(() => resolveDomainOnboarding({ hasOwnDomain: false, label: "www", targetHost: TARGET })).toThrow(TenantError);
  });
});

// ---------------------------------------------------------------------------
// Vercel DNS provider (platform zone hosted on Vercel DNS)
// ---------------------------------------------------------------------------

interface VercelCall { url: string; method: string; headers: Record<string, string>; body?: unknown }

function makeVercelFetch(opts: {
  existing?: Array<{ id: string; name: string; type: string; value: string }>;
  failStatus?: number;
} = {}): { fetchFn: typeof fetch; calls: VercelCall[] } {
  const calls: VercelCall[] = [];
  const fetchFn = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: init?.headers ?? {},
      body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (opts.failStatus) {
      return {
        ok: false,
        status: opts.failStatus,
        statusText: "Forbidden",
        json: async () => ({ error: { code: "forbidden", message: "not allowed" } }),
      } as unknown as Response;
    }
    if (method === "GET") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ records: opts.existing ?? [] }) } as unknown as Response;
    }
    if (method === "DELETE") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ uid: "rec-v1" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("VercelDnsProvider", () => {
  const SECRET = "vercel-secret-token-value";

  it("creates a CNAME via POST with the bearer token, and provisions HTTPS mode vercel-automatic", async () => {
    const { fetchFn, calls } = makeVercelFetch();
    const dns = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", fetchFn });
    const provisioned = await provisionSubdomain({
      userId: "user-a",
      label: "zi1",
      targetHost: TARGET,
      registry: new InMemoryTenantRegistry(),
      dns,
    });
    expect(provisioned.recordId).toBe("rec-v1");
    expect(provisioned.fqdn).toBe("zi1.kailashe.tech");
    expect(provisioned.url).toBe("https://zi1.kailashe.tech");
    expect(provisioned.https.mode).toBe("vercel-automatic");
    expect(provisioned.https.note).toContain("Vercel");

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.vercel.com/v2/domains/kailashe.tech/records");
    expect(post?.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(post?.body).toEqual({ name: "zi1", type: "CNAME", value: TARGET, ttl: 60 });
    const lookup = calls.find((c) => c.method === "GET");
    expect(lookup?.url).toBe("https://api.vercel.com/v4/domains/kailashe.tech/records");
  });

  it("keeps an identical record, replaces a stale one, and deletes on release", async () => {
    const same = makeVercelFetch({ existing: [{ id: "rec-1", name: "zi1", type: "CNAME", value: TARGET }] });
    const dnsSame = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", fetchFn: same.fetchFn });
    await expect(
      dnsSame.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true }),
    ).resolves.toEqual({ recordId: "rec-1" });
    expect(same.calls.some((c) => c.method === "POST")).toBe(false);

    const stale = makeVercelFetch({ existing: [{ id: "rec-2", name: "zi1", type: "CNAME", value: "old.vercel.app" }] });
    const dnsStale = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", fetchFn: stale.fetchFn });
    await expect(
      dnsStale.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true }),
    ).resolves.toEqual({ recordId: "rec-v1" });
    expect(stale.calls.find((c) => c.method === "DELETE")?.url).toBe(
      "https://api.vercel.com/v2/domains/kailashe.tech/records/rec-2",
    );

    await dnsSame.deleteSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech" });
    expect(same.calls.find((c) => c.method === "DELETE")?.url).toBe(
      "https://api.vercel.com/v2/domains/kailashe.tech/records/rec-1",
    );
  });

  it("sends teamId as a query parameter when configured", async () => {
    const { fetchFn, calls } = makeVercelFetch();
    const dns = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", teamId: "team_1", fetchFn });
    await dns.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url).toContain("teamId=team_1");
  });

  it("never leaks the token in thrown errors", async () => {
    const { fetchFn } = makeVercelFetch({ failStatus: 403 });
    const dns = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", fetchFn });
    const err = await dns
      .upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.kailashe.tech", targetHost: TARGET, proxied: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantError);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).toContain("403");
  });

  it("requires a token and validates the fqdn against the platform domain", async () => {
    expect(() => new VercelDnsProvider({ apiToken: "", platformDomain: "kailashe.tech" })).toThrow(TenantError);
    const { fetchFn } = makeVercelFetch();
    const dns = new VercelDnsProvider({ apiToken: SECRET, platformDomain: "kailashe.tech", fetchFn });
    await expect(
      dns.upsertSubdomainRecord({ label: "zi1", fqdn: "zi1.other.com", targetHost: TARGET, proxied: true }),
    ).rejects.toThrow(TenantError);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KAILASHE_COM_NOT_FIT_MESSAGE,
  KailasheComAuthError,
  KailasheComClient,
  assessKailasheComFit,
  collectStaticSite,
  type KailasheComPublishResult,
} from "../src/kailashe-com.js";

const dirs: string[] = [];

function fixture(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "kailashe-com-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake MCP endpoint (streamable HTTP JSON-RPC) — no network in tests.
// ---------------------------------------------------------------------------

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeMcpFetch(calls: RecordedCall[], opts: { failAuth?: boolean } = {}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (opts.failAuth) {
      return jsonResponse({ error: "token revoked", code: "token_revoked" }, 401);
    }
    if (body.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "kailashe-mcp" } },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      const name = body.params?.name ?? "";
      const args = body.params?.arguments ?? {};
      calls.push({ name, args });
      if (name === "kailashe_connection") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: { user: { email: "owner@example.com" }, tenant: "init" } },
        });
      }
      if (name === "kailashe_upload_start") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: { versionId: "ver_test123" } },
        });
      }
      if (name === "kailashe_upload_write") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        });
      }
      if (name === "kailashe_publish") {
        const slug = typeof args["slug"] === "string" ? args["slug"] : "unknown";
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              site: { slug, url: `/s/${slug}`, title: args["title"], kind: "folder" },
              share: { url: "https://www.kailashe.com/v/sharetoken" },
            },
          },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "{}" }] },
      });
    }
    return jsonResponse({ error: "unknown method" }, 400);
  }) as typeof fetch;
}

const SITE = {
  "index.html": "<!doctype html><html><head><title>BCard</title></head><body>hi</body></html>",
  "assets/app.css": "body { margin: 0; }",
  "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
};

// ---------------------------------------------------------------------------
// Static fit
// ---------------------------------------------------------------------------

describe("assessKailasheComFit", () => {
  it("fits a finished static site", () => {
    const fit = assessKailasheComFit({
      appType: "static", artifactKind: "static-dir", rendering: "static", hasIndexHtml: true,
    });
    expect(fit.fit).toBe(true);
  });

  it("refuses dynamic projects (kailashe.com is static-only)", () => {
    const fit = assessKailasheComFit({
      appType: "express", artifactKind: "repo", rendering: "dynamic", hasIndexHtml: false,
    });
    expect(fit.fit).toBe(false);
    expect(fit.reasons.join(" ")).toMatch(/dynamic/);
    expect(KAILASHE_COM_NOT_FIT_MESSAGE).toMatch(/not fit for Kailashe at the moment/);
  });

  it("refuses server apps even when their build output is static", () => {
    const fit = assessKailasheComFit({
      appType: "fastapi", artifactKind: "build-dir", rendering: "static", hasIndexHtml: true,
    });
    expect(fit.fit).toBe(false);
    expect(fit.reasons.join(" ")).toMatch(/server application/);
  });

  it("refuses a framework source tree with no index.html to serve", () => {
    const fit = assessKailasheComFit({
      appType: "vite-spa", artifactKind: "build-dir", rendering: "static", hasIndexHtml: false,
    });
    expect(fit.fit).toBe(false);
    expect(fit.reasons.join(" ")).toMatch(/index\.html/);
  });
});

// ---------------------------------------------------------------------------
// collectStaticSite
// ---------------------------------------------------------------------------

describe("collectStaticSite", () => {
  it("collects a tree, skipping node_modules and .git", async () => {
    const dir = fixture({
      ...SITE,
      "node_modules/leftpad/index.js": "module.exports = 1;",
      ".git/config": "[core]",
    });
    const site = await collectStaticSite(dir);
    expect(site.files.map((f) => f.path)).toEqual([
      "assets/app.css", "assets/logo.png", "index.html",
    ]);
    expect(site.totalBytes).toBeGreaterThan(0);
  });

  it("requires an index.html entry at the root", async () => {
    const dir = fixture({ "about.html": "<html></html>" });
    await expect(collectStaticSite(dir)).rejects.toThrow(/No index\.html/);
  });

  it("skips dot-paths the platform can never serve (and Kailashe's own state dir)", async () => {
    const dir = fixture({
      ...SITE,
      ".well-known/asset.txt": "x",
      ".github/workflows/ci.yml": "name: ci",
      ".kailashe/deploy-state.json": "{}",
    });
    const site = await collectStaticSite(dir);
    expect(site.files.map((f) => f.path)).not.toContain(".well-known/asset.txt");
    expect(site.skipped).toContain(".well-known");
    expect(site.skipped).toContain(".github");
    expect(site.skipped).toContain(".kailashe");
  });

  it("publishes a single .html file as index.html and rejects other files", async () => {
    const dir = fixture({ "page.html": "<html><body>x</body></html>", "notes.txt": "no" });
    const site = await collectStaticSite(join(dir, "page.html"));
    expect(site.files.map((f) => f.path)).toEqual(["index.html"]);
    await expect(collectStaticSite(join(dir, "notes.txt"))).rejects.toThrow(/not fit/);
  });
});

// ---------------------------------------------------------------------------
// KailasheComClient over the fake MCP endpoint
// ---------------------------------------------------------------------------

describe("KailasheComClient", () => {
  it("publishes a small site inline and returns the subdomain URL", async () => {
    const dir = fixture(SITE);
    const site = await collectStaticSite(dir);
    const calls: RecordedCall[] = [];
    const client = new KailasheComClient({ token: "fake-test-token", fetchFn: fakeMcpFetch(calls) });

    const connection = await client.connection();
    expect(connection.email).toBe("owner@example.com");

    const result: KailasheComPublishResult = await client.publishSite({
      title: "bcard",
      slug: "bcard",
      site,
      share: "public",
      operationKey: "deploy-bcard-0123456789abcdef",
    });

    expect(result.slug).toBe("bcard");
    expect(result.liveUrl).toBe("https://bcard.kailashe.com");
    expect(result.siteUrl).toBe("https://www.kailashe.com/s/bcard");
    expect(result.shareUrl).toBe("https://www.kailashe.com/v/sharetoken");

    const publish = calls.find((c) => c.name === "kailashe_publish");
    expect(publish).toBeDefined();
    expect(publish?.args["slug"]).toBe("bcard");
    expect(publish?.args["operation_key"]).toBe("deploy-bcard-0123456789abcdef");
    const files = publish?.args["files"] as Array<{ path: string; encoding: string; content: string }>;
    expect(files.map((f) => f.path)).toEqual(["assets/app.css", "assets/logo.png", "index.html"]);
    // Text travels as UTF-8, binaries as base64 (folder mode contract).
    expect(files.find((f) => f.path === "index.html")?.encoding).toBe("utf8");
    expect(files.find((f) => f.path === "assets/logo.png")?.encoding).toBe("base64");
    expect(calls.some((c) => c.name === "kailashe_upload_start")).toBe(false);
  });

  it("streams large sites through upload_start/upload_write in 256 KiB chunks", async () => {
    const big = new Uint8Array(1_600_000).fill(7);
    const dir = fixture({ "index.html": SITE["index.html"], "assets/big.png": big });
    const site = await collectStaticSite(dir);
    const calls: RecordedCall[] = [];
    const client = new KailasheComClient({ token: "fake-test-token", fetchFn: fakeMcpFetch(calls) });

    const result = await client.publishSite({
      title: "bcard",
      slug: "bcard",
      site,
      share: "none",
      operationKey: "deploy-bcard-fedcba9876543210",
    });
    expect(result.liveUrl).toBe("https://bcard.kailashe.com");
    expect(result.shareUrl).toBe("https://www.kailashe.com/v/sharetoken");

    expect(calls.some((c) => c.name === "kailashe_upload_start")).toBe(true);
    const writes = calls.filter((c) => c.name === "kailashe_upload_write");
    // index.html (small, 1 chunk) + big.png (7 chunks of at most 256 KiB)
    const bigWrites = writes.filter((w) => w.args["path"] === "assets/big.png");
    expect(bigWrites.map((w) => w.args["index"])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(bigWrites.slice(0, -1).every((w) => w.args["final"] === false)).toBe(true);
    expect(bigWrites[bigWrites.length - 1]?.args["final"]).toBe(true);
    for (const w of bigWrites) {
      const decoded = Buffer.from(String(w.args["base64"]), "base64");
      expect(decoded.byteLength).toBeLessThanOrEqual(262_144);
    }
    const publish = calls.find((c) => c.name === "kailashe_publish");
    expect(publish?.args["upload_id"]).toBe("ver_test123");
    expect(publish?.args["share"]).toBe(false);
  });

  it("maps a 401 to an auth error and refuses an empty token", async () => {
    const calls: RecordedCall[] = [];
    const client = new KailasheComClient({
      token: "fake-test-token",
      fetchFn: fakeMcpFetch(calls, { failAuth: true }),
    });
    await expect(client.connection()).rejects.toThrow(KailasheComAuthError);
    expect(() => new KailasheComClient({ token: "  " })).toThrow(KailasheComAuthError);
  });
});

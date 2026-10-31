import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployOperationKey,
  formatDeployOutcome,
  runDeploy,
  type DeployPublishClient,
} from "../src/commands/deploy.js";
import { buildProgram } from "../src/index.js";
import { KAILASHE_COM_NOT_FIT_MESSAGE, KailasheComAuthError } from "@kailashe/deploy";
import type { DetectedProfile } from "@kailashe/scan";

const dirs: string[] = [];

function fixture(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "kailashe-cli-deploy-"));
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

function profile(appType: string, artifactKind: string, rendering: string): DetectedProfile {
  const field = <T,>(value: T) => ({ value, source: "test", confidence: "high" as const });
  return {
    appType: field(appType as DetectedProfile["appType"]["value"]),
    framework: field(null),
    artifactKind: field(artifactKind as DetectedProfile["artifactKind"]["value"]),
    ports: field([]),
    buildCommand: field(null),
    startCommand: field(null),
    envVars: field([]),
    resourceHints: field([]),
    rendering: field(rendering as DetectedProfile["rendering"]["value"]),
    notes: [],
    questions: [],
  };
}

const STATIC_PROFILE = () => profile("static", "static-dir", "static");
const DYNAMIC_PROFILE = () => profile("express", "repo", "dynamic");

function fakeClient(calls: { publish: unknown[] }): DeployPublishClient {
  return {
    base: "https://www.kailashe.com",
    async connection() {
      return { email: "owner@example.com" };
    },
    async publishSite(input) {
      calls.publish.push(input);
      return {
        slug: input.slug,
        siteUrl: `https://www.kailashe.com/s/${input.slug}`,
        liveUrl: `https://${input.slug}.kailashe.com`,
        shareUrl: "https://www.kailashe.com/v/sharetoken",
        title: input.title,
        kind: "folder",
      };
    },
  };
}

const okFetch: typeof fetch = (async () =>
  new Response("ok", { status: 200 })) as typeof fetch;

const SITE = {
  "index.html": "<!doctype html><html><head><title>BCard</title></head><body>hi</body></html>",
  "assets/app.css": "body { margin: 0; }",
  "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

describe("runDeploy", () => {
  it("publishes a static site and records the live URL in deploy-state.json", async () => {
    const dir = fixture(SITE);
    const calls = { publish: [] as unknown[] };
    const outcome = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: { KAILASHE_TOKEN: "fake-test-token" },
        detectProfile: async () => STATIC_PROFILE(),
        createClient: () => fakeClient(calls),
        verifyFetch: okFetch,
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      },
    );

    expect(outcome.status).toBe("deployed");
    expect(outcome.liveUrl).toBe("https://bcard.kailashe.com");
    expect(outcome.account).toBe("owner@example.com");

    expect(calls.publish).toHaveLength(1);
    const published = calls.publish[0] as { slug: string; operationKey: string };
    expect(published.slug).toBe("bcard");
    expect(published.operationKey).toMatch(/^deploy-bcard-[0-9a-f]{16}$/);

    // The plan/prompt steps that follow read the production URL from state.
    const stateFile = join(dir, ".kailashe", "deploy-state.json");
    expect(existsSync(stateFile)).toBe(true);
    const state = readFileSync(stateFile, "utf8");
    expect(state).toContain('"url": "https://bcard.kailashe.com"');
    expect(state).toContain('"provider": "kailashe-com"');
    // The token is never written to state, logs or output.
    expect(state).not.toContain("fake-test-token");
    expect(formatDeployOutcome(outcome).join("\n")).toContain(
      "Share this link: https://www.kailashe.com/v/sharetoken",
    );
    expect(formatDeployOutcome(outcome).join("\n")).not.toContain("fake-test-token");
  });

  it("derives a deterministic operation key from slug + content (safe retry)", async () => {
    const dir = fixture(SITE);
    const first = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: { KAILASHE_TOKEN: "fake-test-token" },
        detectProfile: async () => STATIC_PROFILE(),
        createClient: () => fakeClient({ publish: [] }),
        verifyFetch: okFetch,
      },
    );
    expect(first.status).toBe("deployed");
    const site = await import("@kailashe/deploy").then((m) => m.collectStaticSite(dir));
    expect(deployOperationKey("bcard", site)).toMatch(/^deploy-bcard-[0-9a-f]{16}$/);
    expect(deployOperationKey("bcard", site)).toBe(deployOperationKey("bcard", site));
  });

  it("refuses a dynamic project with the not-fit message and never touches the network", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "4.0.0" } }),
      "server.js": "require('express')().listen(3000);",
    });
    let clientCreated = false;
    let cliClientCreated = false;
    const outcome = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: { KAILASHE_TOKEN: "fake-test-token" },
        detectProfile: async () => DYNAMIC_PROFILE(),
        createClient: () => {
          clientCreated = true;
          return fakeClient({ publish: [] });
        },
        createCliClient: () => {
          cliClientCreated = true;
          return fakeClient({ publish: [] });
        },
        verifyFetch: okFetch,
      },
    );
    expect(outcome.status).toBe("not-fit");
    expect(clientCreated).toBe(false);
    expect(cliClientCreated).toBe(false);
    const lines = formatDeployOutcome(outcome);
    expect(lines[lines.length - 1]).toBe(KAILASHE_COM_NOT_FIT_MESSAGE);
  });

  it("refuses a static-shaped folder with no index.html entry", async () => {
    const dir = fixture({ "about.html": "<html></html>" });
    const outcome = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: { KAILASHE_TOKEN: "fake-test-token" },
        detectProfile: async () => STATIC_PROFILE(),
        createClient: () => fakeClient({ publish: [] }),
        verifyFetch: okFetch,
      },
    );
    expect(outcome.status).toBe("not-fit");
    expect(formatDeployOutcome(outcome).join("\n")).toContain(KAILASHE_COM_NOT_FIT_MESSAGE);
  });

  it("without a token, publishes through the platform CLI login instead of MCP", async () => {
    const dir = fixture(SITE);
    const calls = { publish: [] as unknown[] };
    let mcpCreated = false;
    let cliCreated = false;
    const outcome = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: {},
        detectProfile: async () => STATIC_PROFILE(),
        createClient: () => {
          mcpCreated = true;
          return fakeClient(calls);
        },
        createCliClient: () => {
          cliCreated = true;
          return fakeClient(calls);
        },
        verifyFetch: okFetch,
      },
    );
    expect(outcome.status).toBe("deployed");
    expect(outcome.via).toBe("platform-cli");
    expect(outcome.liveUrl).toBe("https://bcard.kailashe.com");
    expect(mcpCreated).toBe(false);
    expect(cliCreated).toBe(true);
    expect(calls.publish).toHaveLength(1);
    const state = readFileSync(join(dir, ".kailashe", "deploy-state.json"), "utf8");
    expect(state).toContain('"via": "platform-cli"');
    expect(formatDeployOutcome(outcome).join("\n")).toContain("platform CLI login");
  });

  it("surfaces platform CLI auth failures as auth errors (never reads credential files)", async () => {
    const dir = fixture(SITE);
    await expect(
      runDeploy(
        { dir, label: "bcard", share: "public" },
        {
          env: {},
          detectProfile: async () => STATIC_PROFILE(),
          createCliClient: () => ({
            base: "https://www.kailashe.com",
            async connection() {
              throw new KailasheComAuthError("not signed in");
            },
            async publishSite() {
              throw new Error("must not publish");
            },
          }),
          verifyFetch: okFetch,
        },
      ),
    ).rejects.toThrow(KailasheComAuthError);
  });

  it("reports unverified when the live address does not answer yet", async () => {
    const dir = fixture(SITE);
    const outcome = await runDeploy(
      { dir, label: "bcard", share: "public" },
      {
        env: { KAILASHE_TOKEN: "fake-test-token" },
        detectProfile: async () => STATIC_PROFILE(),
        createClient: () => fakeClient({ publish: [] }),
        verifyFetch: (async () => new Response("no", { status: 404 })) as typeof fetch,
        sleep: async () => undefined,
      },
    );
    expect(outcome.status).toBe("unverified");
    expect(outcome.liveUrl).toBe("https://bcard.kailashe.com");
  });
});

describe("deploy command registration", () => {
  it("is registered on the program", () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain("deploy");
  });
});

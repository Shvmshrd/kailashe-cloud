import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROVIDERS_DIR,
  ProviderRegistryError,
  getProvider,
  loadProviders,
  parseProviderYaml,
  patternCovers,
  type ProviderFs,
} from "../src/providers.js";

const EXPECTED_IDS = ["aws", "cloudflare", "cloudflare-workers", "digitalocean", "fly", "kailashe-com", "modal", "vercel"];

function fakeFs(files: Record<string, string>): ProviderFs {
  return {
    readdir: async () => Object.keys(files),
    readFile: async (path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const content = files[name];
      if (content === undefined) throw new Error(`missing ${name}`);
      return content;
    },
  };
}

const MINIMAL_YAML = `
id: demo
name: Demo
cliBinary: demo
install:
  - os: linux
    command: "install demo"
    sourceUrl: "https://example.com/install"
login:
  command: "demo login"
verify:
  command: "demo whoami"
allowedPatterns:
  - pattern: "demo login"
    class: iam-billing-network
  - pattern: "demo whoami"
    class: read
`;

describe("real providers/*.yaml registry", () => {
  it("loads exactly the registered providers, all valid", async () => {
    const providers = await loadProviders(DEFAULT_PROVIDERS_DIR);
    expect(providers.map((p) => p.id)).toEqual(EXPECTED_IDS);
  });

  it("every provider has per-OS install commands with https official sources", async () => {
    const providers = await loadProviders(DEFAULT_PROVIDERS_DIR);
    for (const p of providers) {
      expect(p.install.map((i) => i.os).sort(), p.id).toEqual(["linux", "macos", "windows"]);
      for (const entry of p.install) {
        expect(entry.command.length, `${p.id}/${entry.os}`).toBeGreaterThan(0);
        expect(entry.sourceUrl.startsWith("https://"), `${p.id}/${entry.os}`).toBe(true);
      }
      expect(p.docsDomains.length, p.id).toBeGreaterThan(0);
      expect(p.health?.path, p.id).toBe("/");
      expect(p.tagging?.key, p.id).toBe("kailashe-project");
    }
  });

  it("verify and login commands are covered by each allowlist as read / iam classes", async () => {
    const providers = await loadProviders(DEFAULT_PROVIDERS_DIR);
    for (const p of providers) {
      const verifyPattern = p.allowedPatterns.find((a) => patternCovers([a.pattern], p.verify.command));
      expect(verifyPattern?.class, `${p.id} verify`).toBe("read");
      expect(patternCovers(p.allowedPatterns.map((a) => a.pattern), p.login.command), `${p.id} login`).toBe(true);
      for (const a of p.allowedPatterns) {
        expect(["read", "create", "modify", "delete", "iam-billing-network"]).toContain(a.class);
      }
    }
  });

  it("AWS is image-only per SPEC F2a: ECR/ECS Express/Lightsail, no EC2/Fargate assembly/App Runner", async () => {
    const aws = getProvider(await loadProviders(DEFAULT_PROVIDERS_DIR), "aws");
    const patterns = aws.allowedPatterns.map((a) => a.pattern);
    expect(patterns).toContain("aws sts get-caller-identity");
    expect(patterns).toContain("aws ecr create-repository");
    expect(patterns.some((p) => p.startsWith("aws ecs create-express"))).toBe(true);
    expect(patterns.some((p) => p.startsWith("aws lightsail create-container-service"))).toBe(true);
    const ecrPw = aws.allowedPatterns.find((a) => a.pattern === "aws ecr get-login-password");
    expect(ecrPw?.class).toBe("iam-billing-network");
    for (const denied of ["aws ec2", "aws apprunner", "aws ecs create-cluster", "aws ecs register-task-definition"]) {
      expect(patterns.some((p) => p.startsWith(denied)), denied).toBe(false);
    }
    expect(aws.verify.command).toBe("aws sts get-caller-identity");
  });

  it("install source URLs are on official provider domains", async () => {
    const providers = await loadProviders(DEFAULT_PROVIDERS_DIR);
    const official: Record<string, string[]> = {
      aws: ["docs.aws.amazon.com"],
      digitalocean: ["docs.digitalocean.com"],
      vercel: ["vercel.com"],
      cloudflare: ["developers.cloudflare.com"],
      "cloudflare-workers": ["developers.cloudflare.com"],
      fly: ["fly.io"],
      modal: ["modal.com"],
      "kailashe-com": ["www.kailashe.com"],
    };
    for (const p of providers) {
      for (const entry of p.install) {
        const host = new URL(entry.sourceUrl).hostname;
        expect(official[p.id], `${p.id}: ${entry.sourceUrl}`).toContain(host);
      }
    }
  });
});

describe("loader validation", () => {
  it("rejects an invalid provider document with field-level errors", () => {
    expect(() => parseProviderYaml("id: BAD ID!\nname: x\n")).toThrow(ProviderRegistryError);
    expect(() => parseProviderYaml("id: BAD ID!\nname: x\n")).toThrow(/id:/);
  });

  it("rejects non-YAML and empty registries", async () => {
    await expect(loadProviders("/nonexistent-dir-xyz", fakeFs({}))).rejects.toThrow(/no provider YAML/);
  });

  it("rejects duplicate ids and filename/id mismatch", async () => {
    const fs = fakeFs({ "demo.yaml": MINIMAL_YAML, "demo2.yaml": MINIMAL_YAML });
    await expect(loadProviders("/x", fs)).rejects.toThrow(ProviderRegistryError);
    await expect(loadProviders("/x", fakeFs({ "other.yaml": MINIMAL_YAML }))).rejects.toThrow(/must match filename/);
  });

  it("rejects a verify command outside the allowlist", async () => {
    const bad = MINIMAL_YAML.replace('pattern: "demo whoami"', 'pattern: "demo other"');
    await expect(loadProviders("/x", fakeFs({ "demo.yaml": bad }))).rejects.toThrow(/verify command/);
  });
});

describe("credential material is never read", () => {
  it("loader only opens *.yaml files, ignoring decoy secret files in the same directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kailashe-providers-"));
    await writeFile(join(dir, "demo.yaml"), MINIMAL_YAML);
    await writeFile(join(dir, "decoy-secret.txt"), "DO_NOT_LEAK_THIS_VALUE");
    const opened: string[] = [];
    const fs: ProviderFs = {
      readdir: async () => ["demo.yaml", "decoy-secret.txt"],
      readFile: async (path) => {
        opened.push(path);
        return readFile(path, "utf8");
      },
    };
    const providers = await loadProviders(dir, fs);
    expect(providers.map((p) => p.id)).toEqual(["demo"]);
    expect(opened.every((p) => p.endsWith(".yaml"))).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("DO_NOT_LEAK_THIS_VALUE");
  });

  it("grep proof: registry/bootstrap/choice sources contain no provider credential-store paths", async () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    // Fragments are built dynamically so this test file is not itself a hit.
    const forbidden = [
      [".a", "ws"].join(""),
      ["cred", "entials"].join(""),
      [".con", "fig/doctl"].join(""),
      ["auth", ".json"].join(""),
      ["id_r", "sa"].join(""),
      [".ver", "cel"].join(""),
      [".fly", "/"].join(""),
    ];
    for (const file of ["providers.ts", "bootstrap.ts", "choice.ts"]) {
      const source = await readFile(join(srcDir, file), "utf8");
      for (const fragment of forbidden) {
        expect(source.includes(fragment), `${file} must not reference ${fragment}`).toBe(false);
      }
      expect(source).not.toMatch(/shell\s*:\s*true/);
    }
  });
});

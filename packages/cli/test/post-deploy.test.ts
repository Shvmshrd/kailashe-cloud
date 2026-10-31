import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePostDeployArtifacts } from "../src/commands/post-deploy.js";
import type { DetectedProfile } from "@kailashe/scan";

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kailashe-post-deploy-"));
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

function staticProfile(): DetectedProfile {
  const field = <T,>(value: T) => ({ value, source: "test", confidence: "high" as const });
  return {
    appType: field("static" as DetectedProfile["appType"]["value"]),
    framework: field(null),
    artifactKind: field("static-dir" as DetectedProfile["artifactKind"]["value"]),
    ports: field([]),
    buildCommand: field(null),
    startCommand: field(null),
    envVars: field([]),
    resourceHints: field([]),
    rendering: field("static" as DetectedProfile["rendering"]["value"]),
    notes: [],
    questions: [],
  };
}

describe("generatePostDeployArtifacts", () => {
  it("writes business-plan.md and prompt.md addressed at the live URL", async () => {
    const dir = fixture({
      "README.md":
        "# vCard\n\nvCard is a fully responsive personal portfolio website, responsive for all devices, built using HTML, CSS, and JavaScript.\n",
      "index.html":
        "<!doctype html><html><head><title>vCard - Personal Portfolio</title></head><body><h1>Richard hanrick</h1><h2>About me</h2></body></html>",
    });
    const artifacts = await generatePostDeployArtifacts({
      dir,
      slug: "bcard",
      liveUrl: "https://bcard.kailashe.com",
      shareUrl: "https://www.kailashe.com/v/sharetoken",
      profile: staticProfile(),
      now: new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(artifacts.archetype).not.toBe("");
    expect(existsSync(artifacts.businessPlanFile)).toBe(true);
    expect(existsSync(artifacts.promptFile)).toBe(true);

    const plan = readFileSync(artifacts.businessPlanFile, "utf8");
    expect(plan).toContain("https://bcard.kailashe.com");
    expect(plan).toContain("(source: README.md)");
    expect(plan).toContain("## Unknowns");

    const prompt = readFileSync(artifacts.promptFile, "utf8");
    expect(prompt).toContain("https://bcard.kailashe.com");
    // No credential material is ever generated into the prompt.
    expect(prompt).not.toMatch(/KAILASHE_TOKEN|Bearer [A-Za-z0-9]/);
  });

  it("still works for a bare folder with no README and no title", async () => {
    const dir = fixture({
      "index.html": "<!doctype html><html><head></head><body>hi</body></html>",
    });
    const artifacts = await generatePostDeployArtifacts({
      dir,
      slug: "bare",
      liveUrl: "https://bare.kailashe.com",
      shareUrl: null,
      profile: staticProfile(),
    });
    const plan = readFileSync(artifacts.businessPlanFile, "utf8");
    expect(plan).toContain("https://bare.kailashe.com");
    expect(plan).toContain("Unknown");
  });
});

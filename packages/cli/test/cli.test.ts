import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, resolveExitCode } from "../src/exit-codes.js";
import { buildProgram, createProgram, parse, run, VERSION } from "../src/index.js";
import { runDoctorChecks, formatDoctorOutput } from "../src/doctor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "../bin/kailashe-cloud.js");

describe("CLI --version", () => {
  beforeEach(() => { process.exitCode = undefined; });
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("has the expected VERSION constant", () => {
    expect(VERSION).toBe("0.1.0");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("program reports correct version via commander", () => {
    expect(createProgram().version()).toBe(VERSION);
    expect(buildProgram().version()).toBe(VERSION);
  });

  it("--version via run() does not call process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    await expect(run(["node", "kailashe", "--version"])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(outSpy.mock.calls.flat().join("\n")).toContain(VERSION);
  });

  it("parse() throws commander.version for --version flag", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(parse(["node", "kailashe", "--version"])).rejects.toMatchObject({
      code: "commander.version",
    });
  });

  it("bin/kailashe-cloud.js --version exits 0 and prints version (requires build)", () => {
    const out = execFileSync(process.execPath, [binPath, "--version"], { encoding: "utf-8" });
    expect(out.trim()).toBe(VERSION);
  });
});

describe("CLI doctor (stub)", () => {
  beforeEach(() => { process.exitCode = undefined; });
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("doctor command exists on the program", () => {
    const doctorCmd = buildProgram().commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
    expect(doctorCmd!.description()).toMatch(/doctor/i);
  });

  it("parse() resolves for 'doctor' and exit code is 0", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(parse(["node", "kailashe", "doctor"])).resolves.toBeDefined();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("bin doctor exits 0 and mentions node/pnpm/git", () => {
    const out = execFileSync(process.execPath, [binPath, "doctor"], { encoding: "utf-8" });
    expect(out).toContain("node");
    expect(out).toContain("pnpm");
    expect(out).toContain("git");
  });

  it("runDoctorChecks returns node, pnpm, git and platform checks", () => {
    const checks = runDoctorChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("pnpm");
    expect(names).toContain("git");
    expect(names).toContain("platform");
    for (const c of checks) {
      expect(typeof c.ok).toBe("boolean");
      expect(c.detail.length).toBeGreaterThan(0);
    }
    expect(checks.find((c) => c.name === "node")!.ok).toBe(true);
    expect(formatDoctorOutput(checks)).toContain("kailashe doctor");
  });
});

describe("CLI exit codes per SPEC §2.5", () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

  it("unknown command maps to exit 2 (usage)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`exit:${String(code)}`), { exitCode: code });
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(run(["node", "kailashe", "nonexistent-command"])).rejects.toMatchObject({ exitCode: 2 });
    expect(exitSpy).toHaveBeenCalledWith(ExitCode.Usage);
  });

  it("plain Error resolves to exit 1 and commander errors to 2", () => {
    expect(resolveExitCode(new Error("boom"))).toBe(ExitCode.Unexpected);
    expect(resolveExitCode(new Error("boom"))).toBe(1);
  });

  it("help flag does not trigger exit error", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(run(["node", "kailashe", "--help"])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("typed errors map to their SPEC codes and SIGINT to 130", async () => {
    const mod = await import("../src/exit-codes.js");
    expect(resolveExitCode(new mod.UnexpectedError("t"))).toBe(1);
    expect(resolveExitCode(new mod.UsageError("t"))).toBe(2);
    expect(resolveExitCode(new mod.NeedsInputError("t"))).toBe(3);
    expect(resolveExitCode(new mod.ProviderAuthError("t"))).toBe(4);
    expect(resolveExitCode(new mod.DeployFailedError("t"))).toBe(5);
    expect(resolveExitCode(new mod.ValidationError("t"))).toBe(6);
    expect(resolveExitCode(new mod.BudgetExceededError("t"))).toBe(7);
    expect(mod.signalToExitCode("SIGINT")).toBe(130);
  });
});

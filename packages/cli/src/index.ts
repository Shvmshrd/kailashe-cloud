import { createRequire } from "node:module";
import * as path from "node:path";
import { Command } from "commander";
import { createDomainCommand } from "./commands/domain.js";
import { createDeployCommand } from "./commands/deploy.js";
import { createGraphCommand } from "./commands/graph.js";
import { createGateCommand } from "./commands/gate.js";
import { runDoctor } from "./commands/doctor.js";
import { createInitCommand } from "./commands/init.js";
import { runValidatePack } from "./commands/validate-pack.js";
import {
  ExitCode,
  resolveExitCode,
  installSigintHandler,
  isCommanderSuccess,
} from "./exit-codes.js";

export {
  ExitCode,
  resolveExitCode,
  installSigintHandler,
  isCommanderSuccess,
} from "./exit-codes.js";
export { runDoctorChecks, formatDoctorOutput } from "./doctor.js";
export type { DoctorCheck } from "./doctor.js";
export { validatePack, VALID_FLOW_IDS } from "./validate-pack.js";
export { runInit, findPackDir } from "./init.js";
export type { InitOptions, InitResult } from "./init.js";

const require = createRequire(import.meta.url);

function readVersion(): string {
  const here = import.meta.dirname ?? ".";
  const candidates = [
    path.resolve(here, "../package.json"),
    path.resolve(here, "../../package.json"),
    path.resolve(here, "../../../package.json"),
    "../../package.json",
    "../../../package.json",
  ];
  for (const c of candidates) {
    try {
      const pkg = require(c) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "0.1.0";
}

export const VERSION: string = readVersion();

function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("kailashe-cloud")
    .description("Kailashe — deploy and operate side projects")
    .version(VERSION, "--version");

  program.addCommand(createDomainCommand());
  program.addCommand(createDeployCommand());
  program.addCommand(createGraphCommand());
  program.addCommand(createGateCommand());
  program.addCommand(createInitCommand());

  program
    .command("doctor")
    .description("doctor: check environment (node, pnpm, git)")
    .action(() => {
      runDoctor();
      process.exitCode = ExitCode.Ok;
    });

  program
    .command("validate-pack")
    .description("Validate the skill pack")
    .option("--lenient", "Downgrade errors to warnings (never in CI)")
    .option("--pack-dir <dir>", "Pack directory override")
    .action((opts: { lenient?: boolean; packDir?: string }) => {
      runValidatePack(opts);
    });

  applyExitOverride(program);
  return program;
}

/** Alias kept for callers/tests that use the create* naming convention. */
export const createProgram: typeof buildProgram = buildProgram;

export async function parse(argv: string[] = process.argv): Promise<Command> {
  const program = buildProgram();
  await program.parseAsync(argv);
  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  try {
    await parse(argv);
  } catch (err) {
    if (isCommanderSuccess(err)) return;
    const code = resolveExitCode(err);
    process.exit(code);
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  installSigintHandler();
  await run(argv);
}

// Auto-run only when this module is the process entry is handled by
// bin/kailashe.js, which imports { main } from dist/index.js and calls it.

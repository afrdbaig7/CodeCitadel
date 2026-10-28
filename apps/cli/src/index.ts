#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";

import { EXIT_CODES } from "@codecitadel/contracts";
import { CODECITADEL_VERSION } from "@codecitadel/core";
import {
  ScanAbortedError,
  ScannerBinaryNotFoundError,
  ScannerProtocolError,
  ScannerRunError,
  ScannerTimeoutError,
} from "@codecitadel/scanner-client";

import { runCompareCommand, type CompareCommandOptions } from "./commands/compare.js";
import {
  runDemoCouponRaceCommand,
  type DemoCouponRaceCommandOptions,
} from "./commands/demo.js";
import { runDiffCommand, type DiffCommandOptions } from "./commands/diff.js";
import { runPatchVerifyCommand, type PatchVerifyCommandOptions } from "./commands/patch.js";
import {
  runEvidenceExportCommand,
  type EvidenceExportCommandOptions,
} from "./commands/evidence.js";
import {
  runReplayCommand,
  type ReplayCommandOptions,
} from "./commands/replay.js";
import {
  runReproduceCommand,
  runReproduceExportCommand,
  type ReproduceCommandOptions,
  type ReproduceExportCommandOptions,
} from "./commands/reproduce.js";
import { runDoctorCommand, type DoctorCommandOptions } from "./commands/doctor.js";
import { runImpactCommand, type ImpactCommandOptions } from "./commands/impact.js";
import {
  runRequirementsAcceptCommand,
  runRequirementsCheckCommand,
  runRequirementsListCommand,
  type RequirementsAcceptCommandOptions,
  type RequirementsCheckCommandOptions,
  type RequirementsListCommandOptions,
} from "./commands/requirements.js";
import { runRunCommand, type RunCommandOptions } from "./commands/run.js";
import { runScanCommand, type ScanCommandOptions } from "./commands/scan.js";
import { runUploadCommand, type UploadCommandOptions } from "./commands/upload.js";
import { UsageError } from "./errors.js";

const SEVERITIES = ["critical", "high", "medium", "low", "info", "none"];

function buildProgram(setExitCode: (code: number) => void): Command {
  const program = new Command();

  program
    .name("codecitadel")
    .description("What changed, what could break, and what evidence do we have?")
    .version(CODECITADEL_VERSION, "-v, --version")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("scan")
    .description("Passively scan a directory. Never executes repository code.")
    .argument("[path]", "directory to scan", ".")
    .option("-f, --format <format>", "output format: json, markdown, or sarif", "json")
    .option("-o, --out <file>", "write the report to a file instead of stdout")
    .addOption(
      new Option("--fail-on <severity>", "exit 1 when a finding is at or above this severity")
        .choices(SEVERITIES)
        .default("high"),
    )
    .option("--rules <ids...>", "run only these rule IDs")
    .option("--exclude <globs...>", "gitignore-style exclusion globs")
    .option("--max-files <count>", "stop after N discovered files")
    .option("--scanner <path>", "path to the scanner binary")
    .option("--save-snapshot <file>", "write an immutable snapshot of this scan")
    .option("--verbose", "stream skip and warning diagnostics to stderr")
    .action(async (pathArgument: string, options: ScanCommandOptions) => {
      setExitCode(await runScanCommand(pathArgument, options));
    });

  program
    .command("diff")
    .description("Compare a stored snapshot with the current tree. Never executes repository code.")
    .argument("[path]", "directory to treat as the head", ".")
    .requiredOption("-b, --base <file>", "snapshot file to compare against")
    .option("-f, --format <format>", "output format: text, json, or markdown", "text")
    .addOption(
      new Option("--fail-on <severity>", "exit 1 when an introduced finding is at or above this severity")
        .choices(SEVERITIES)
        .default("none"),
    )
    .option("--save-snapshot <file>", "also write the head snapshot to this file")
    .option("--scanner <path>", "path to the scanner binary")
    .action(async (pathArgument: string, options: DiffCommandOptions) => {
      setExitCode(await runDiffCommand(pathArgument, options));
    });

  program
    .command("impact")
    .description("List files and tests that can see the changes since a snapshot. Never executes code.")
    .argument("[path]", "directory to treat as the head", ".")
    .requiredOption("-b, --base <file>", "snapshot file to compare against")
    .option("-f, --format <format>", "output format: text or json", "text")
    .option("--scanner <path>", "path to the scanner binary")
    .action(async (pathArgument: string, options: ImpactCommandOptions) => {
      setExitCode(await runImpactCommand(pathArgument, options));
    });

  program
    .command("run")
    .description("Execute the tests that can see the changes since a snapshot. Runs repository code.")
    .argument("[path]", "directory to treat as the head", ".")
    .requiredOption("-b, --base <file>", "snapshot file to compare against")
    .option("-f, --format <format>", "output format: text or json", "text")
    .option("-o, --out <file>", "write the report to a file instead of stdout")
    .option("--isolation <mode>", 'isolation mode: "copy" (default) or "none" (run in the checkout)')
    .option("--timeout-ms <ms>", "kill the runner after this many milliseconds")
    .option("--runner <path>", "path to node_modules/vitest/vitest.mjs in the target project")
    .option("--save-raw <file>", "write the runner's raw JSON report next to the normalized one")
    .option("--scanner <path>", "path to the scanner binary")
    .option(
      "--env <names>",
      "comma-separated variable names to forward to the runner; values are copied from this process and only the names are recorded",
    )
    .action(async (pathArgument: string, options: RunCommandOptions) => {
      setExitCode(await runRunCommand(pathArgument, options));
    });

  program
    .command("compare")
    .description(
      "Compare two stored run reports by test fingerprint. Reads two files; never executes code.",
    )
    .requiredOption("--before <file>", "earlier run report file")
    .requiredOption("--after <file>", "later run report file")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (options: CompareCommandOptions) => {
      setExitCode(await runCompareCommand(options));
    });

  const requirements = program
    .command("requirements")
    .description(
      "Read, accept, and evaluate a declarative requirement document. Executes no repository code.",
    );

  requirements
    .command("list")
    .argument("[path]", "directory or requirement document", ".")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (pathArgument: string, options: RequirementsListCommandOptions) => {
      setExitCode(await runRequirementsListCommand(pathArgument, options));
    });

  requirements
    .command("accept")
    .argument("<id>", "requirement id to accept as currently written")
    .argument("[path]", "directory or requirement document", ".")
    .option("--by <name>", "who is recording the acceptance")
    .action(
      async (
        id: string,
        pathArgument: string,
        options: RequirementsAcceptCommandOptions,
      ) => {
        setExitCode(await runRequirementsAcceptCommand(id, pathArgument, options));
      },
    );

  requirements
    .command("check")
    .argument("[path]", "directory or requirement document", ".")
    .requiredOption("--report <file>", "stored run report to evaluate the checks against")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (pathArgument: string, options: RequirementsCheckCommandOptions) => {
      setExitCode(await runRequirementsCheckCommand(pathArgument, options));
    });

  const patch = program
    .command("patch")
    .description(
      "Verify a patch against a stored run: apply it in a disposable copy, re-execute the same checks, and inspect the diff. Runs repository code.",
    );

  patch
    .command("verify")
    .argument("<patch>", "unified diff file to verify")
    .requiredOption("--before <file>", "stored run report whose test selection is re-executed unchanged")
    .option(
      "--requirements <path>",
      "requirement document to evaluate (defaults to codecitadel.requirements.json in the analyzed root)",
    )
    .option("-f, --format <format>", "output format: text or json", "text")
    .option("-o, --out <file>", "write the report to a file instead of stdout")
    .option("--timeout-ms <ms>", "kill the runner after this many milliseconds")
    .option("--runner <path>", "path to node_modules/vitest/vitest.mjs in the target project")
    .option(
      "--env <names>",
      "comma-separated variable names to forward to the runner; values are copied from this process and only the names are recorded",
    )
    .action(async (patchArgument: string, options: PatchVerifyCommandOptions) => {
      setExitCode(await runPatchVerifyCommand(patchArgument, options));
    });

  const reproduce = program
    .command("reproduce")
    .description(
      "Run one declared reproduction, or export a stored one as a portable regression test.",
    );

  reproduce
    .command("run")
    .description(
      "Execute one declared reproduction in a disposable copy and record whether the expected failure occurred. Runs repository code.",
    )
    .argument("<manifest>", "reproduction manifest declaring the check and its expected behavior")
    .argument("[path]", "directory to analyze", ".")
    .requiredOption("--id <id>", "reproduction id declared in the manifest")
    .option(
      "--requirements <path>",
      "requirement document the reproduction is answerable to (defaults to codecitadel.requirements.json in the analyzed root)",
    )
    .option("-f, --format <format>", "output format: text or json", "text")
    .option("-o, --out <file>", "write the report to a file instead of stdout")
    .option("--timeout-ms <ms>", "kill the runner after this many milliseconds")
    .option("--runner <path>", "path to node_modules/vitest/vitest.mjs in the target project")
    .option(
      "--env <names>",
      "comma-separated variable names to forward to the runner; values are copied from this process and only the names are recorded",
    )
    .action(async (manifestArgument: string, pathArgument: string, options: ReproduceCommandOptions) => {
      setExitCode(await runReproduceCommand(manifestArgument, pathArgument, options));
    });

  reproduce
    .command("export")
    .description(
      "Write a stored reproduction's test source and its provenance manifest. Executes nothing.",
    )
    .argument("<report>", "stored reproduction report to export")
    .requiredOption("--out <dir>", "directory to write the exported test and manifest into")
    .option("--force", "overwrite an existing file at the destination")
    .option("--in-root", "allow writing inside the analyzed checkout")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (reportArgument: string, options: ReproduceExportCommandOptions) => {
      setExitCode(await runReproduceExportCommand(reportArgument, options));
    });

  const demo = program
    .command("demo")
    .description(
      "Run an end-to-end demonstration against a real project. Starts a disposable database and runs repository code.",
    );

  demo
    .command("coupon-race")
    .description(
      "Accept the requirement, reproduce the concurrent coupon redemption on a real database, and verify the labeled patch that fixes it.",
    )
    .option("--project <dir>", "demo project to demonstrate against", "examples/shopping-api")
    .option("--runner <path>", "path to node_modules/vitest/vitest.mjs in the demo project")
    .option("--scanner <path>", "path to the scanner binary")
    .option(
      "--database-url <url>",
      "use this PostgreSQL server instead of starting a disposable container",
    )
    .option("--port <port>", "host port for the disposable container (default: a free port)")
    .option("--by <name>", "who records the acceptance if the requirement is not accepted yet")
    .option("-o, --out <dir>", "directory for the demo's artifacts", ".codecitadel/demo/coupon-race")
    .option("--keep", "leave the disposable copy and the container in place")
    .option("--timeout-ms <ms>", "kill the runner after this many milliseconds")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (options: DemoCouponRaceCommandOptions) => {
      setExitCode(await runDemoCouponRaceCommand(options));
    });

  const evidence = program
    .command("evidence")
    .description("Export and manage self-contained, tamper-evident verification evidence bundles.");

  evidence
    .command("export")
    .description("Package a stored report and its artifacts into an Evidence Bundle. Executes nothing.")
    .argument("<report>", "stored report file (reproduction, run, or patch-verification)")
    .option("-o, --out <file>", "destination bundle file (defaults to .codecitadel/bundles/<id>.bundle.json)")
    .option("--force", "overwrite an existing file at destination")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (reportArgument: string, options: EvidenceExportCommandOptions) => {
      setExitCode(await runEvidenceExportCommand(reportArgument, options));
    });

  program
    .command("replay")
    .description("Replay an evidence bundle against a target repository in an isolated disposable copy.")
    .argument("<bundle>", "evidence bundle file to replay")
    .argument("[path]", "directory to analyze", ".")
    .option("--runner <path>", "path to node_modules/vitest/vitest.mjs in the target project")
    .option("--env <names>", "comma-separated environment variable names to forward")
    .option("-o, --out <file>", "write the replay report to a file")
    .option("--timeout-ms <ms>", "kill the runner after this many milliseconds")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (bundleArgument: string, pathArgument: string | undefined, options: ReplayCommandOptions) => {
      setExitCode(await runReplayCommand(bundleArgument, pathArgument, options));
    });

  program
    .command("upload")
    .description(
      "Upload a stored report to a CodeCitadel control plane. Reads one file and sends it; executes nothing.",
    )
    .argument("<report>", "stored report file written by a codecitadel command")
    .requiredOption(
      "--server <url>",
      "base URL of the control plane, for example http://127.0.0.1:4317",
    )
    .option("--token <value>", "bearer token (defaults to the CODECITADEL_TOKEN environment variable)")
    .option("--kind <kind>", "report kind, when the file does not match exactly one contract")
    .option(
      "--repository <name>",
      "repository to file the report under (defaults to the report's own root directory name)",
    )
    .option("--commit <ref>", "commit the report was captured at")
    .option("--branch <name>", "branch the report was captured on")
    .option("--origin <origin>", 'who executed the checks: "local" (default) or "user-ci"')
    .option(
      "--artifact <file>",
      "small evidence file to send with the report (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--timeout-ms <ms>", "give up after this many milliseconds (default 60000)")
    .option("-f, --format <format>", "output format: text or json", "text")
    .action(async (reportArgument: string, options: UploadCommandOptions) => {
      setExitCode(await runUploadCommand(reportArgument, options));
    });

  program
    .command("doctor")
    .description("Check the local environment, scanner binary, and protocol compatibility")
    .option("-f, --format <format>", "output format: text or json", "text")
    .option("--scanner <path>", "path to the scanner binary")
    .action(async (options: DoctorCommandOptions) => {
      setExitCode(await runDoctorCommand(options));
    });

  return program;
}

function describeError(error: unknown): string {
  if (error instanceof UsageError) {
    return error.message;
  }
  if (error instanceof ScannerBinaryNotFoundError) {
    return error.message;
  }
  if (error instanceof ScannerRunError) {
    return `scanner error [${error.code}]: ${error.message}`;
  }
  if (error instanceof ScannerProtocolError) {
    return `scanner protocol error: ${error.message}`;
  }
  if (error instanceof ScannerTimeoutError) {
    return error.message;
  }
  if (error instanceof ScanAbortedError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(argv: readonly string[]): Promise<number> {
  let exitCode: number = EXIT_CODES.ok;
  const program = buildProgram((code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync([...argv]);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are successful exits; commander already printed them.
      if (error.exitCode === 0) {
        return EXIT_CODES.ok;
      }
      return EXIT_CODES.error;
    }
    process.stderr.write(`codecitadel: ${describeError(error)}\n`);
    return EXIT_CODES.error;
  }
}

void main(process.argv).then((code) => {
  process.exitCode = code;
});

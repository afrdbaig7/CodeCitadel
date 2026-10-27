import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEMO_REPORT_SCHEMA_VERSION,
  EXIT_CODES,
  patchVerificationReportSchema,
  reproductionReportSchema,
  type DemoAct,
  type DemoActStatus,
  type DemoReport,
  type ExitCode,
} from "@codecitadel/contracts";
import { acceptanceStatusOf } from "@codecitadel/core";

import {
  dockerEngineVersion,
  findFreePort,
  removeContainer,
  startPostgresContainer,
  type StartedContainer,
} from "../docker.js";
import { UsageError, parsePositiveInt } from "../errors.js";
import { readRequirementDocument, requirementDocumentPath } from "../requirement-file.js";

import { runPatchVerifyCommand } from "./patch.js";
import { runReproduceCommand } from "./reproduce.js";
import { runRequirementsAcceptCommand } from "./requirements.js";
import { runRunCommand } from "./run.js";
import { runScanCommand } from "./scan.js";

export const DEMO_ID = "coupon-race";
const DEFAULT_PROJECT = path.join("examples", "shopping-api");
const REQUIREMENT_ID = "coupon.single-redemption";
const REPRODUCTION_ID = "coupon.concurrent-redemption";
const PATCH_NAME = path.join("patches", "0001-coupon-single-redemption.patch");
const CONTAINER_IMAGE = "postgres:16-alpine";
/** The one variable the demo names for forwarding; its value is the demo URL. */
const DEMO_DATABASE_ENV = "CODECITADEL_DEMO_PG_URL";

export interface DemoCouponRaceCommandOptions {
  project?: string;
  runner?: string;
  scanner?: string;
  databaseUrl?: string;
  port?: string;
  by?: string;
  out?: string;
  keep?: boolean;
  timeoutMs?: string;
  format?: string;
}

interface Artifacts {
  directory: string;
  scanReport: string;
  snapshot: string;
  before: string;
  reproduction: string;
  patchVerify: string;
  report: string;
}

/** Where each act's evidence goes. Every file is refused if it already exists. */
async function prepareArtifacts(out: string | undefined): Promise<Artifacts> {
  const directory = path.resolve(out ?? path.join(".codecitadel", "demo", DEMO_ID));
  const artifacts: Artifacts = {
    directory,
    scanReport: path.join(directory, "scan-report.json"),
    snapshot: path.join(directory, "snapshot.json"),
    before: path.join(directory, "before.json"),
    reproduction: path.join(directory, "reproduction.json"),
    patchVerify: path.join(directory, "patch-verify.json"),
    report: path.join(directory, "demo-report.json"),
  };
  const taken = [
    artifacts.scanReport,
    artifacts.snapshot,
    artifacts.before,
    artifacts.reproduction,
    artifacts.patchVerify,
    artifacts.report,
  ].filter((file) => existsSync(file));
  if (taken.length > 0) {
    throw new UsageError(
      `Refusing to overwrite the existing artifact(s) ${taken.join(", ")}. ` +
        "A demo's evidence must not be silently replaced: pass a fresh --out directory.",
    );
  }
  await mkdir(directory, { recursive: true });
  return artifacts;
}

function requireProjectFile(root: string, relative: string, purpose: string): void {
  if (!existsSync(path.join(root, relative))) {
    throw new UsageError(
      `The demo project at ${root} has no ${relative} (${purpose}). ` +
        "Pass --project <dir> pointing at a checkout of the demo fixture.",
    );
  }
}

/** The project must be complete before any act claims to have performed it. */
function inspectProject(root: string): string {
  requireProjectFile(root, "codecitadel.requirements.json", "the accepted requirement");
  requireProjectFile(root, "codecitadel.reproductions.json", "the declared reproduction");
  requireProjectFile(root, PATCH_NAME, "the labeled patch");
  requireProjectFile(root, path.join("src", "coupons.ts"), "the vulnerable service");
  requireProjectFile(root, path.join("reproductions", "coupon-race.test.ts"), "the concurrent check");
  requireProjectFile(root, path.join("test", "coupon.test.ts"), "the sequential checks");

  const candidate = path.join(root, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(candidate)) {
    throw new UsageError(
      `The demo project at ${root} has no Vitest installation (looked for ${candidate}). ` +
        "Install the project's dependencies first, or pass --runner <path-to-vitest.mjs>.",
    );
  }
  return candidate;
}

/** Copies the project without its dependencies, which the executor links back. */
async function copyProject(root: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "codecitadel-demo-"));
  const copy = path.join(parent, "shopping-api");
  await cp(root, copy, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  return copy;
}

function renderDemoText(report: DemoReport): string {
  const lines: string[] = [];
  lines.push(`coupon-race demo → ${report.outcome.toUpperCase()}`);
  lines.push("");
  lines.push(`  project    ${report.project}`);
  lines.push(`  work copy  ${report.workCopy}`);
  const where =
    report.database.mode === "container"
      ? `container ${report.database.container ?? "?"} on ${report.database.host}:${report.database.port}`
      : `external ${report.database.host}:${report.database.port}`;
  lines.push(`  database   ${where}, database ${report.database.database}`);
  lines.push("");
  lines.push("acts (performed by this command, or recorded from evidence that already existed)");
  for (const act of report.acts) {
    lines.push(`  ${act.status.padEnd(9)} ${act.id.padEnd(14)} ${act.detail}`);
  }
  lines.push("");
  lines.push(
    `  requirement ${report.requirement.id}: ${report.requirement.status}` +
      (report.requirement.digest === null ? "" : ` (${report.requirement.digest.slice(0, 23)}…)`),
  );
  if (report.reproduction !== null) {
    lines.push(`  reproduction ${report.reproduction.id}: ${report.reproduction.verdict}`);
    lines.push(`    report ${report.reproduction.report}`);
  }
  if (report.patch !== null) {
    lines.push(`  patch ${report.patch.verdict} (${report.patch.digest.slice(0, 23)}…)`);
    lines.push(`    report ${report.patch.report}`);
  }
  lines.push("");
  lines.push("limitations");
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `codecitadel demo coupon-race`
 *
 * One command, six acts, in order: a disposable PostgreSQL (or one the operator
 * names), a disposable copy of the demo project, the requirement acceptance,
 * the baseline run that selects the check, the reproduction, and the labeled
 * patch verified against that unchanged selection. The checkout is never
 * written to: every act that runs repository code runs inside the copy.
 *
 * Each act is labeled `performed` (done now), `recorded` (established earlier
 * and reused), `skipped`, or `failed`, so a reader can see which part of the
 * story was demonstrated and which part was recorded.
 *
 * Exit codes: 0 when the race reproduced and the patch verified, 1 when the
 * demonstration ran but the patch did not earn `verified`, 2 when nothing was
 * established.
 */
export async function runDemoCouponRaceCommand(
  options: DemoCouponRaceCommandOptions,
): Promise<ExitCode> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, received "${format}".`);
  }
  // Validated here so a bad value is refused before any act starts; the value
  // itself is handed to the sub-commands, which parse their own flags.
  if (options.timeoutMs !== undefined) {
    parsePositiveInt(options.timeoutMs, "--timeout-ms");
  }
  const hostPort = options.port === undefined ? undefined : parsePositiveInt(options.port, "--port");

  const project = path.resolve(options.project ?? DEFAULT_PROJECT);
  if (!existsSync(project)) {
    throw new UsageError(
      `The demo project at ${project} does not exist. Pass --project <dir>, or run this from the repository root.`,
    );
  }
  const runner = options.runner ?? inspectProject(project);
  const artifacts = await prepareArtifacts(options.out);

  const acts: DemoAct[] = [];
  const record = (id: string, status: DemoActStatus, detail: string): void => {
    acts.push({ id, status, detail });
  };

  let container: StartedContainer | null = null;
  let workCopy: string | null = null;
  let databaseHost = "127.0.0.1";
  let databasePort = hostPort ?? 0;
  let databaseMode: "container" | "external" = "container";
  let requirementStatus: DemoActStatus = "skipped";
  let requirementDigest: string | null = null;

  const previousDatabaseUrl = process.env[DEMO_DATABASE_ENV];
  let outcome: DemoReport["outcome"] = "inconclusive";
  let failure: Error | null = null;

  try {
    // Act 1 — the database. A named URL wins over a container, because the
    // operator may already have a disposable server and must not be given one.
    if (options.databaseUrl !== undefined) {
      databaseMode = "external";
      const url = new URL(options.databaseUrl);
      databaseHost = url.hostname;
      databasePort = url.port === "" ? 5432 : Number.parseInt(url.port, 10);
      record(
        "database",
        "recorded",
        `using the external server at ${databaseHost}:${databasePort} named by --database-url; no container was started.`,
      );
    } else {
      const engine = await dockerEngineVersion();
      if (engine === null) {
        throw new UsageError(
          "The coupon-race demo needs a disposable PostgreSQL and no Docker engine answered. " +
            "Start Docker, or pass --database-url postgres://… to use an existing server.",
        );
      }
      databasePort = hostPort ?? (await findFreePort());
      container = await startPostgresContainer({
        name: `codecitadel-demo-${DEMO_ID}-${randomBytes(4).toString("hex")}`,
        hostPort: databasePort,
        image: CONTAINER_IMAGE,
      });
      record(
        "database",
        "performed",
        `started ${CONTAINER_IMAGE} (${container.serverVersion}) as ${container.name} on 127.0.0.1:${databasePort}; removed at teardown.`,
      );
    }

    // The executor copies this one name into the disposable copy's
    // environment; nothing else from this process is inherited.
    process.env[DEMO_DATABASE_ENV] =
      options.databaseUrl ?? `postgres://postgres:postgres@127.0.0.1:${databasePort}/codecitadel`;

    // Act 2 — the disposable copy. Everything below runs here.
    workCopy = await copyProject(project);
    record(
      "work copy",
      "performed",
      `copied the project to ${workCopy} without node_modules, which the executor links back from the checkout.`,
    );

    // Act 3 — the requirement: accepted now if the fixture only proposes it,
    // recorded if the fixture already carries a current acceptance.
    const requirementFile = requirementDocumentPath(workCopy);
    const document = await readRequirementDocument(requirementFile);
    const existing = document.requirements.find((entry) => entry.id === REQUIREMENT_ID);
    if (existing === undefined) {
      throw new UsageError(
        `The demo project declares no requirement ${REQUIREMENT_ID}, so the reproduction has nothing to answer to.`,
      );
    }
    if (existing.state === "accepted" && acceptanceStatusOf(existing) === "current") {
      requirementStatus = "recorded";
      requirementDigest = existing.acceptance?.digest ?? null;
      record(
        "requirement",
        "recorded",
        `${REQUIREMENT_ID} was already accepted as written by ${existing.acceptance?.acceptedBy ?? "an unknown party"}; the acceptance was reused, not re-created.`,
      );
    } else {
      const acceptedBy = options.by?.trim() || "codecitadel-demo";
      const code = await runRequirementsAcceptCommand(REQUIREMENT_ID, workCopy, { by: acceptedBy });
      if (code !== EXIT_CODES.ok) {
        throw new Error(`accepting ${REQUIREMENT_ID} exited with code ${code}`);
      }
      const after = await readRequirementDocument(requirementFile);
      requirementDigest = after.requirements.find((entry) => entry.id === REQUIREMENT_ID)
        ?.acceptance?.digest ?? null;
      requirementStatus = "performed";
      record(
        "requirement",
        "performed",
        `accepted ${REQUIREMENT_ID} as written by ${acceptedBy}; the digest binds the approval to this exact text.`,
      );
    }

    // Act 4 — the evidence the patch is judged against: a baseline snapshot of
    // the untouched copy, a change that makes the reproduction selectable, and
    // the run that fails.
    const scanned = await runScanCommand(workCopy, {
      format: "json",
      out: artifacts.scanReport,
      failOn: "none",
      saveSnapshot: artifacts.snapshot,
      ...(options.scanner !== undefined ? { scanner: options.scanner } : {}),
    });
    if (scanned !== EXIT_CODES.ok) {
      throw new Error(`scanning the disposable copy exited with code ${scanned}`);
    }
    record("snapshot", "performed", `recorded a baseline of the copy at ${artifacts.snapshot}.`);

    // The change comes after the baseline: without a difference from the
    // snapshot, change analysis selects nothing and the demo would "pass" with
    // zero tests executed.
    const changeMarker = "\n// codecitadel demo: this change is what selects the reproduction.\n";
    await appendFile(path.join(workCopy, "src", "coupons.ts"), changeMarker, "utf8");
    record("change", "performed", "touched src/coupons.ts in the copy, which is what selects the concurrent check.");

    const beforeRun = await runRunCommand(workCopy, {
      base: artifacts.snapshot,
      format: "json",
      out: artifacts.before,
      ...(options.scanner !== undefined ? { scanner: options.scanner } : {}),
      ...(runner !== undefined ? { runner } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      env: DEMO_DATABASE_ENV,
    });
    if (beforeRun !== EXIT_CODES.policyBreach) {
      throw new Error(
        `the baseline run exited with code ${beforeRun}; the concurrent check was expected to fail before any patch`,
      );
    }
    record(
      "before run",
      "performed",
      "the concurrent check failed against the vulnerable tree: this is the evidence the patch must resolve.",
    );

    const reproduced = await runReproduceCommand(
      path.join(workCopy, "codecitadel.reproductions.json"),
      workCopy,
      {
        id: REPRODUCTION_ID,
        format: "json",
        out: artifacts.reproduction,
        ...(runner !== undefined ? { runner } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        env: DEMO_DATABASE_ENV,
      },
    );
    if (reproduced !== EXIT_CODES.ok) {
      throw new Error(
        `reproduce run exited with code ${reproduced}: the expected failure was not observed`,
      );
    }
    record(
      "reproduction",
      "performed",
      `ran ${REPRODUCTION_ID} in the copy and classified it reproduced from the named test's own result.`,
    );

    // Act 5 — the patch: applied only inside a disposable copy, judged against
    // the unchanged selection stored in the before report.
    const verification = await runPatchVerifyCommand(path.join(workCopy, PATCH_NAME), {
      before: artifacts.before,
      format: "json",
      out: artifacts.patchVerify,
      ...(runner !== undefined ? { runner } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      env: DEMO_DATABASE_ENV,
    });
    const patchReport = patchVerificationReportSchema.parse(
      JSON.parse(await readFile(artifacts.patchVerify, "utf8")),
    );
    record(
      "patch verify",
      verification === EXIT_CODES.ok ? "performed" : "failed",
      `${patchReport.verdict}: ${patchReport.reason}`,
    );

    outcome =
      verification === EXIT_CODES.ok && acts.every((entry) => entry.status !== "failed")
        ? "demonstrated"
        : "not_demonstrated";
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    failure = error as Error;
    process.stderr.write(`demo coupon-race: ${failure.message}\n`);
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env[DEMO_DATABASE_ENV];
    } else {
      process.env[DEMO_DATABASE_ENV] = previousDatabaseUrl;
    }
    if (options.keep === true) {
      record(
        "teardown",
        "skipped",
        `--keep was requested: ${workCopy ?? "the copy"} and ${container?.name ?? "no container"} were left in place.`,
      );
    } else {
      if (workCopy !== null) {
        await rm(path.dirname(workCopy), { recursive: true, force: true }).catch(() => undefined);
      }
      if (container !== null) {
        await removeContainer(container.name).catch((error: Error) => {
          process.stderr.write(`demo coupon-race: ${error.message}\n`);
        });
      }
      record(
        "teardown",
        "performed",
        "removed the disposable copy and the database container; the checkout was never written to.",
      );
    }
  }

  const reproduction =
    existsSync(artifacts.reproduction)
      ? reproductionReportSchema.parse(JSON.parse(await readFile(artifacts.reproduction, "utf8")))
      : null;
  const patchReport = existsSync(artifacts.patchVerify)
    ? patchVerificationReportSchema.parse(JSON.parse(await readFile(artifacts.patchVerify, "utf8")))
    : null;

  const report: DemoReport = {
    schemaVersion: DEMO_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    demo: "coupon-race",
    project,
    workCopy: workCopy ?? "(removed)",
    database: {
      mode: databaseMode,
      container: container?.name ?? null,
      host: databaseHost,
      port: databasePort,
      database: databaseMode === "container" ? "codecitadel" : "(see --database-url)",
      serverVersion: container?.serverVersion ?? null,
    },
    acts,
    requirement: { id: REQUIREMENT_ID, status: requirementStatus, digest: requirementDigest },
    reproduction:
      reproduction === null
        ? null
        : { id: REPRODUCTION_ID, verdict: reproduction.verdict, report: artifacts.reproduction },
    patch:
      patchReport === null
        ? null
        : { verdict: patchReport.verdict, digest: patchReport.patch.digest, report: artifacts.patchVerify },
    outcome,
    limitations: [
      "Every act that ran repository code ran it inside a disposable copy of the project; the checkout was never modified and no patch was applied to it.",
      "The database was a disposable container holding demo data only. It is not platform storage, and no platform credential was read or written.",
      "The concurrency is synchronized by the hold hook the check sets inside its own process, so the interleaving repeats. It is not evidence about how often the race happens without the hook.",
      "The patch was verified against the selection stored in the before report; a test the patch adds would not have been executed.",
      "A demonstration is evidence for these tests, in this environment, under this patch. It is not a claim that the project is free of similar defects.",
    ],
  };

  const rendered =
    format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderDemoText(report);
  await writeFile(artifacts.report, rendered, "utf8");
  process.stderr.write(`demo report written to ${artifacts.report}\n`);
  process.stdout.write(rendered);

  if (failure !== null && outcome === "inconclusive") {
    process.stderr.write(
      "coupon-race demo → inconclusive: the demonstration stopped early and established neither claim.\n",
    );
    return EXIT_CODES.error;
  }
  process.stderr.write(
    `coupon-race demo → ${outcome}: ` +
      (outcome === "demonstrated"
        ? "the race reproduced on a real database and the labeled patch fixed it.\n"
        : "the demonstration ran, but the patch did not earn a verified verdict.\n"),
  );

  switch (outcome) {
    case "demonstrated":
      return EXIT_CODES.ok;
    case "not_demonstrated":
      return EXIT_CODES.policyBreach;
    default:
      return EXIT_CODES.error;
  }
}

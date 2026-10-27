import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Proves the release shape end to end: pack every workspace package, install
 * the tarballs into an empty directory outside the repository, and scan with no
 * Cargo build and no environment overrides.
 *
 * This is the R0 distribution gate. It runs on the host platform only, so it
 * proves "an installer works here", not "every target is supported".
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const platformPackage = `@codecitadel/scanner-${target}`;

const PACKAGES = [
  "@codecitadel/contracts",
  "@codecitadel/scanner-client",
  "@codecitadel/core",
  "@codecitadel/executor",
  "@codecitadel/symbol-graph",
  platformPackage,
  "@codecitadel/cli",
];

function quoteForCmd(arg) {
  return /[\s&|<>^]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Runs a command and returns its stdout.
 *
 * Windows needs a command line rather than an argv vector because `npm` and
 * `pnpm` are `.cmd` shims, and `node` itself usually lives under "C:\\Program
 * Files". Every element is quoted individually so spaces in these paths survive.
 */
function run(command, args, options = {}) {
  const stdio = options.stdio ?? ["ignore", "pipe", "pipe"];
  if (process.platform === "win32") {
    const line = [command, ...args].map(quoteForCmd).join(" ");
    return execSync(line, { encoding: "utf8", stdio, ...options });
  }
  return execFileSync(command, args, { encoding: "utf8", stdio, ...options });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function attempt(command, args, options) {
  try {
    return { code: 0, stdout: run(command, args, options), stderr: "" };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 2,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  failures.push(name);
}

function requireArtifacts() {
  if (!existsSync(path.join(root, "apps/cli/dist/index.js"))) {
    throw new Error("apps/cli/dist is missing. Run `pnpm build` before verifying the package.");
  }
  if (!existsSync(path.join(root, "npm", `scanner-${target}`, "binary.json"))) {
    console.log(`No scanner artifact for ${target}; building it first...`);
    run(process.execPath, [path.join(root, "scripts/package-scanner.mjs")], { stdio: "inherit" });
  }
}

requireArtifacts();

const workspace = mkdtempSync(path.join(tmpdir(), "codecitadel-pack-"));
const tarballDir = path.join(workspace, "tarballs");
mkdirSync(tarballDir, { recursive: true });

try {
  console.log(`\nPacking ${PACKAGES.length} package(s) into ${tarballDir}`);
  for (const name of PACKAGES) {
    run("pnpm", ["--filter", name, "pack", "--pack-destination", tarballDir], { cwd: root });
  }
  const tarballs = readdirSync(tarballDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(tarballDir, entry));
  check("every package produced a tarball", tarballs.length === PACKAGES.length, `${tarballs.length} of ${PACKAGES.length}`);

  const installDir = path.join(workspace, "consumer");
  cpSync(path.join(root, "fixtures/clean"), path.join(workspace, "clean"), { recursive: true });
  cpSync(path.join(root, "fixtures/security"), path.join(workspace, "faulty"), { recursive: true });

  console.log("\nInstalling the tarballs into an empty directory");
  // --omit=optional keeps npm from asking the registry for the two platform
  // packages that do not match this host; the matching one is a direct argument.
  const install = attempt(
    "npm",
    ["install", "--no-audit", "--no-fund", "--omit=optional", "--omit=dev", ...tarballs],
    { cwd: workspace, env: { ...process.env, npm_config_yes: "true" } },
  );
  if (install.code !== 0) {
    console.error(install.stderr.slice(-2000));
    throw new Error(`npm install exited ${install.code}`);
  }

  const cli = path.join(workspace, "node_modules", "@codecitadel", "cli", "dist", "index.js");
  check("the CLI is installed outside the repository", existsSync(cli), cli);

  // A clean environment: no scanner override, and a cwd that has no Cargo build
  // anywhere above it.
  const env = { ...process.env };
  delete env.CODECITADEL_SCANNER_BIN;

  const version = attempt(process.execPath, [cli, "--version"], { cwd: workspace, env });
  check("the packed binary reports a version", version.code === 0 && version.stdout.trim() !== "", version.stderr.trim());

  const doctor = attempt(process.execPath, [cli, "doctor", "--format", "json"], { cwd: workspace, env });
  const doctorPayload = parseJson(doctor.stdout);
  const binaryCheck = doctorPayload?.checks?.find((entry) => entry.name === "scanner binary");
  check("doctor passes", doctor.code === 0 && doctorPayload.ok === true, doctor.stderr.trim());
  check(
    "the scanner comes from the installed platform package",
    typeof binaryCheck?.detail === "string" && binaryCheck.detail.includes("platform-package"),
    binaryCheck?.detail,
  );
  check(
    "the scanner binary lives inside the installed tree",
    typeof binaryCheck?.detail === "string" && binaryCheck.detail.startsWith(workspace),
    binaryCheck?.detail,
  );

  const clean = attempt(process.execPath, [cli, "scan", path.join(workspace, "clean"), "--format", "json"], {
    cwd: workspace,
    env,
  });
  const cleanReport = parseJson(clean.stdout);
  check("a clean repository exits 0", clean.code === 0, clean.stderr.trim());
  check("a clean repository has no findings", cleanReport?.summary?.findings === 0);

  const faulty = attempt(process.execPath, [cli, "scan", path.join(workspace, "faulty"), "--format", "json"], {
    cwd: workspace,
    env,
  });
  const faultyReport = parseJson(faulty.stdout);
  check("a faulty repository exits 1 by default policy", faulty.code === 1, String(faulty.code));
  check("a faulty repository reports 5 findings", faultyReport?.summary?.findings === 5);
  check(
    "the scan never prints the matched secret",
    !faulty.stdout.includes("AKIAIOSFODNN7EXAMPLE"),
  );

  const markdown = attempt(
    process.execPath,
    [cli, "scan", path.join(workspace, "faulty"), "--format", "markdown", "--fail-on", "none"],
    { cwd: workspace, env },
  );
  check(
    "the Markdown report renders from the packed install",
    markdown.code === 0 && markdown.stdout.includes("## Limitations"),
    markdown.stderr.trim(),
  );

  const sarif = attempt(
    process.execPath,
    [cli, "scan", path.join(workspace, "faulty"), "--format", "sarif", "--fail-on", "none"],
    { cwd: workspace, env },
  );
  const sarifPayload = parseJson(sarif.stdout);
  const sarifRun = sarifPayload?.runs?.[0];
  check(
    "the packed CLI emits SARIF 2.1.0 with every rule attached to a result",
    sarif.code === 0 &&
      sarifPayload?.version === "2.1.0" &&
      sarifRun?.results?.length === 5 &&
      sarifRun.results.every(
        (entry) => sarifRun.tool?.driver?.rules?.[entry.ruleIndex]?.id === entry.ruleId,
      ),
    sarif.stderr.trim(),
  );
  check("the SARIF report never prints the matched secret", !sarif.stdout.includes("AKIAIOSFODNN7EXAMPLE"));

  const snapshotFile = path.join(workspace, "clean-snapshot.json");
  const snapshot = attempt(
    process.execPath,
    [
      cli,
      "scan",
      path.join(workspace, "clean"),
      "--fail-on",
      "none",
      "--save-snapshot",
      snapshotFile,
    ],
    { cwd: workspace, env },
  );
  check(
    "the packed CLI writes a snapshot",
    snapshot.code === 0 && existsSync(snapshotFile),
    snapshot.stderr.trim(),
  );

  const unchanged = attempt(
    process.execPath,
    [
      cli,
      "diff",
      path.join(workspace, "clean"),
      "--base",
      snapshotFile,
      "--format",
      "json",
    ],
    { cwd: workspace, env },
  );
  const unchangedPayload = parseJson(unchanged.stdout);
  check(
    "an unchanged tree reports no introduced findings",
    unchanged.code === 0 &&
      unchangedPayload?.findings?.introduced?.length === 0 &&
      unchangedPayload?.files?.unchanged > 0,
    unchanged.stderr.trim(),
  );

  // One real change, so the comparison is proven to detect something rather
  // than trivially returning empty lists.
  writeFileSync(
    path.join(workspace, "clean", "added-by-check.js"),
    'const { exec } = require("child_process");\nexec("echo hi", { shell: true });\n',
    "utf8",
  );
  const changed = attempt(
    process.execPath,
    [
      cli,
      "diff",
      path.join(workspace, "clean"),
      "--base",
      snapshotFile,
      "--fail-on",
      "medium",
    ],
    { cwd: workspace, env },
  );
  check(
    "an introduced finding is reported and can gate the diff",
    changed.code === 1 && changed.stdout.includes("security/shell-enabled-subprocess"),
    changed.stderr.trim(),
  );

  // Impact analysis needs a project with a real import graph, so the fixture is
  // copied in and one module is edited after the baseline snapshot.
  cpSync(path.join(root, "fixtures/impact"), path.join(workspace, "impact"), {
    recursive: true,
  });
  const impactSnapshot = path.join(workspace, "impact-snapshot.json");
  const impactScan = attempt(
    process.execPath,
    [
      cli,
      "scan",
      path.join(workspace, "impact"),
      "--fail-on",
      "none",
      "--save-snapshot",
      impactSnapshot,
    ],
    { cwd: workspace, env },
  );
  check(
    "the packed CLI snapshots a project before analysis",
    impactScan.code === 0 && existsSync(impactSnapshot),
    impactScan.stderr.trim(),
  );

  const mathFile = path.join(workspace, "impact", "src", "math.ts");
  writeFileSync(
    mathFile,
    `${readFileSync(mathFile, "utf8")}\nexport function subtract(left: number, right: number): number {\n  return left - right;\n}\n`,
    "utf8",
  );
  const impact = attempt(
    process.execPath,
    [
      cli,
      "impact",
      path.join(workspace, "impact"),
      "--base",
      impactSnapshot,
      "--format",
      "json",
    ],
    { cwd: workspace, env },
  );
  const impactPayload = parseJson(impact.stdout);
  const selectedTests = (impactPayload?.tests?.selected ?? []).map((entry) => entry.path);
  check(
    "impact selects the test that imports the changed module",
    impact.code === 0 &&
      selectedTests.length === 1 &&
      selectedTests[0] === "src/math.test.ts",
    impact.stderr.trim(),
  );
  check(
    "impact reports a complete graph for the fixture",
    impactPayload?.complete === true,
    (impactPayload?.incompleteReasons ?? []).join("; "),
  );

  // Confirms the tarball is self-contained: no path into this checkout survives.
  const installedCli = readFileSync(cli, "utf8");
  check("the packed CLI contains no absolute path into this checkout", !installedCli.includes(root));
} finally {
  if (process.env.KEEP_PACK_SMOKE === "1") {
    console.log(`\nKept ${workspace} (KEEP_PACK_SMOKE=1)`);
  } else {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}

console.log(`\nAll packed-install checks passed for ${target}.`);

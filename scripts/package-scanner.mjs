import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the scanner and installs the artifact into the platform package that
 * matches this host: `npm/scanner-<platform>-<arch>`.
 *
 * Only the host target is produced. Cross-compiling needs a linker and SDK for
 * the target platform, which this repository does not configure; the release
 * plan is to run this script once per target on real hardware or in CI.
 *
 * Writes `binary.json` next to the binary so the client can verify what it will
 * execute. The manifest is generated, not hand-maintained, because a stale
 * checksum would either reject a good binary or bless a tampered one.
 */

const root = fileURLToPath(new URL("../", import.meta.url));

const SUPPORTED = new Set(["win32-x64", "linux-x64", "darwin-arm64"]);

const target = `${process.platform}-${process.arch}`;
const packageDir = path.join(root, "npm", `scanner-${target}`);
const executable = process.platform === "win32" ? "codecitadel-scanner.exe" : "codecitadel-scanner";

if (!SUPPORTED.has(target)) {
  throw new Error(
    [
      `No platform package for ${target}.`,
      `Configured targets: ${[...SUPPORTED].join(", ")}.`,
      "Add npm/scanner-<platform>-<arch>/package.json before adding the target here.",
    ].join("\n"),
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function scannerCrateVersion() {
  const raw = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--locked"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const metadata = JSON.parse(raw);
  const crate = metadata.packages.find((entry) => entry.name === "scanner-cli");
  if (!crate) {
    throw new Error("cargo metadata did not report a scanner-cli package.");
  }
  return crate.version;
}

/**
 * The CLI pins each platform package by version. If the three disagree, npm
 * resolves nothing on install and the failure surfaces as "binary not found"
 * far from the cause, so it is caught here instead.
 */
const versions = {
  "scanner-cli crate": scannerCrateVersion(),
  "apps/cli": readJson(path.join(root, "apps/cli/package.json")).version,
  [`npm/scanner-${target}`]: readJson(path.join(packageDir, "package.json")).version,
};

const distinct = new Set(Object.values(versions));
if (distinct.size > 1) {
  const detail = Object.entries(versions)
    .map(([name, version]) => `  ${name}: ${version}`)
    .join("\n");
  throw new Error(`Version mismatch; bump all of these together:\n${detail}`);
}

const version = [...distinct][0];

console.log(`Building scanner-cli ${version} for ${target}...`);
execFileSync("cargo", ["build", "--release", "--package", "scanner-cli"], {
  cwd: root,
  stdio: "inherit",
});

const built = path.join(root, "target", "release", executable);
if (!existsSync(built)) {
  throw new Error(`cargo build finished but ${built} does not exist.`);
}

const binDir = path.join(packageDir, "bin");
mkdirSync(binDir, { recursive: true });
const installed = path.join(binDir, executable);
copyFileSync(built, installed);
// No effect on Windows, where the executable bit is not part of the file.
chmodSync(installed, 0o755);

const bytes = readFileSync(installed);
const manifest = {
  file: `bin/${executable}`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: statSync(installed).size,
  target,
  version,
};
writeFileSync(path.join(packageDir, "binary.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  [
    "",
    `Installed ${path.relative(root, installed)}`,
    `  ${manifest.sizeBytes} bytes, sha256 ${manifest.sha256}`,
    `Wrote npm/scanner-${target}/binary.json`,
  ].join("\n"),
);

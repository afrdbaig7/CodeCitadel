import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a resolved scanner binary came from. Reported by `doctor` so a stale
 * development build is never mistaken for an installed release.
 */
export type BinarySource = "explicit" | "environment" | "platform-package" | "workspace-build";

export interface ResolvedScanner {
  path: string;
  source: BinarySource;
}

export interface ResolveScannerOptions {
  /** Caller-supplied path; must point at a file. */
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Directory to search upward from. Defaults to `process.cwd()`. */
  startDir?: string;
}

export class ScannerBinaryNotFoundError extends Error {
  readonly tried: string[];

  constructor(tried: string[]) {
    super(
      [
        "Cannot find the CodeCitadel scanner binary.",
        "Install a release (which provides @codecitadel/scanner-<platform>-<arch>),",
        "build it with `cargo build --release` (or `pnpm scanner:build`), or point",
        "CODECITADEL_SCANNER_BIN at an installed binary.",
        "Looked for:",
        ...tried.map((candidate) => `  - ${candidate}`),
      ].join("\n"),
    );
    this.name = "ScannerBinaryNotFoundError";
    this.tried = tried;
  }
}

/**
 * Raised when a platform package is present but its contents cannot be trusted.
 *
 * This is deliberately fatal rather than a fallthrough: falling back to another
 * binary after a failed check would hide the tampering or corruption.
 */
export class ScannerBinaryIntegrityError extends Error {
  readonly packageName: string;
  readonly binaryPath: string;

  constructor(packageName: string, binaryPath: string, problem: string) {
    super(
      [
        `The installed scanner binary failed its integrity check (${packageName}).`,
        `  binary: ${binaryPath}`,
        `  problem: ${problem}`,
        "Reinstall it, or run `node scripts/package-scanner.mjs` to rebuild the artifact.",
      ].join("\n"),
    );
    this.name = "ScannerBinaryIntegrityError";
    this.packageName = packageName;
    this.binaryPath = binaryPath;
  }
}

/** Shape of the generated `binary.json` shipped inside a platform package. */
interface BinaryManifest {
  file: string;
  sha256: string;
}

function executableName(): string {
  return process.platform === "win32" ? "codecitadel-scanner.exe" : "codecitadel-scanner";
}

/** npm package that carries the binary for a given platform, e.g. `…-win32-x64`. */
export function platformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `@codecitadel/scanner-${platform}-${arch}`;
}

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` looking for `node_modules/<packageName>`.
 *
 * Bounded for the same reason as the Cargo walk below: a scan started deep in a
 * filesystem should not traverse to the drive root.
 */
function findInstalledPackage(startDir: string, packageName: string): string | undefined {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "node_modules", packageName);
    if (isDirectory(candidate) && isFile(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Reads the generated manifest, or `undefined` when the package has not been
 * built yet.
 *
 * A workspace link exists as soon as `pnpm install` runs, so "directory present,
 * no manifest" is the normal unbuilt state and must not block the fallback to a
 * Cargo build. A binary without a manifest, on the other hand, means someone
 * removed the checksum, which is fatal.
 */
function readManifest(packageDir: string, packageName: string): BinaryManifest | undefined {
  const manifestPath = path.join(packageDir, "binary.json");
  if (!isFile(manifestPath)) {
    const strayBinary = path.join(packageDir, "bin", executableName());
    if (isFile(strayBinary)) {
      throw new ScannerBinaryIntegrityError(
        packageName,
        strayBinary,
        "a binary is present but binary.json is missing, so its checksum is unknown",
      );
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ScannerBinaryIntegrityError(
      packageName,
      manifestPath,
      `binary.json is not valid JSON (${(error as Error).message})`,
    );
  }

  const manifest = parsed as Partial<BinaryManifest> | null;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof manifest.file !== "string" ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  ) {
    throw new ScannerBinaryIntegrityError(
      packageName,
      manifestPath,
      "binary.json must contain a string `file` and a lowercase hex `sha256`",
    );
  }
  return { file: manifest.file, sha256: manifest.sha256 };
}

/**
 * Resolves and verifies a binary shipped in a platform package.
 *
 * The digest is computed on every run. It costs a few milliseconds for a
 * multi-megabyte binary and is the only way to notice a binary that changed
 * after install, which is exactly the case a checksum exists to catch.
 */
function resolveFromPlatformPackage(
  packageDir: string,
  packageName: string,
): ResolvedScanner | undefined {
  const manifest = readManifest(packageDir, packageName);
  if (!manifest) {
    return undefined;
  }
  const binaryPath = path.resolve(packageDir, manifest.file);

  // A manifest is generated locally, not received from a network peer, but a
  // `../..` in it would still make the client execute an unrelated file.
  const relative = path.relative(packageDir, binaryPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ScannerBinaryIntegrityError(
      packageName,
      binaryPath,
      "binary.json points outside its own package",
    );
  }

  if (!isFile(binaryPath)) {
    throw new ScannerBinaryIntegrityError(
      packageName,
      binaryPath,
      "binary.json points at a file that is not present",
    );
  }

  const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actual !== manifest.sha256) {
    throw new ScannerBinaryIntegrityError(
      packageName,
      binaryPath,
      `sha256 mismatch: manifest says ${manifest.sha256}, file is ${actual}`,
    );
  }

  return { path: binaryPath, source: "platform-package" };
}

/**
 * Walks up from `startDir` looking for a Cargo build output of this repository.
 *
 * This exists so a contributor's freshly built binary is used without an
 * install step. It is a development convenience, not a distribution
 * mechanism: the release path uses a platform package.
 */
function findWorkspaceBuild(startDir: string): string | undefined {
  const name = executableName();
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const profile of ["release", "debug"]) {
      const candidate = path.join(current, "target", profile, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

export function resolveScannerBinary(options: ResolveScannerOptions = {}): ResolvedScanner {
  const tried: string[] = [];

  if (options.explicitPath) {
    tried.push(`--scanner ${options.explicitPath}`);
    if (!isFile(options.explicitPath)) {
      throw new ScannerBinaryNotFoundError(tried);
    }
    return { path: path.resolve(options.explicitPath), source: "explicit" };
  }

  const env = options.env ?? process.env;
  const fromEnv = env.CODECITADEL_SCANNER_BIN;
  if (fromEnv) {
    tried.push(`CODECITADEL_SCANNER_BIN=${fromEnv}`);
    if (!isFile(fromEnv)) {
      throw new ScannerBinaryNotFoundError(tried);
    }
    return { path: path.resolve(fromEnv), source: "environment" };
  }

  // Two roots, because the package that ships the binary and the process that
  // runs it are installed side by side, while the working directory may be
  // anywhere on disk.
  const packageName = platformPackageName();
  const searchRoots = [
    path.dirname(fileURLToPath(import.meta.url)),
    options.startDir ?? process.cwd(),
  ];
  for (const root of searchRoots) {
    const packageDir = findInstalledPackage(root, packageName);
    if (packageDir) {
      const resolved = resolveFromPlatformPackage(packageDir, packageName);
      if (resolved) {
        return resolved;
      }
    }
  }
  tried.push(`node_modules/${packageName} (searching upward from this package and the working directory)`);

  const startDir = options.startDir ?? process.cwd();
  const workspaceBuild = findWorkspaceBuild(startDir);
  if (workspaceBuild) {
    return { path: workspaceBuild, source: "workspace-build" };
  }
  tried.push("target/release (searching upward from the working directory)");
  tried.push("target/debug (searching upward from the working directory)");

  throw new ScannerBinaryNotFoundError(tried);
}

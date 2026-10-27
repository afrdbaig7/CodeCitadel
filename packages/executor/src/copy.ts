import { copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A disposable copy of the analyzed tree.
 *
 * The copy exists so a test run cannot rewrite the checkout that the change
 * analysis and the snapshot describe. It is deliberately dumb: files are copied
 * one at a time, symlinks are skipped, and directories that are dependencies or
 * build output are left behind.
 *
 * It is **not** a sandbox. There is no CPU, memory, network, or syscall limit,
 * and `node_modules` is shared with the checkout by link rather than copied.
 * Re-installing dependencies per run would be correct but costs minutes on a
 * real repository, so the sharing is reported in the execution record instead
 * of being hidden.
 */

/** Directories that are never copied: either huge, generated, or evidence. */
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".nuxt",
  ".cache",
  ".pnpm-store",
  ".codecitadel",
  ".venv",
  "__pycache__",
]);

export interface SourceCopyLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_COPY_LIMITS: SourceCopyLimits = {
  maxFiles: 20_000,
  maxBytes: 256 * 1024 * 1024,
};

/** Thrown when the tree is too large to copy, before anything is executed. */
export class SourceCopyLimitError extends Error {
  constructor(
    message: string,
    readonly limit: keyof SourceCopyLimits,
  ) {
    super(message);
    this.name = "SourceCopyLimitError";
  }
}

export interface SourceCopy {
  /** Absolute path of the copy. */
  dir: string;
  /** Relative POSIX paths that are linked to the checkout instead of copied. */
  sharedPaths: string[];
  /** Removes the copy. Safe to call more than once. */
  dispose(): Promise<void>;
}

interface CopyState {
  files: number;
  bytes: number;
  sharedPaths: string[];
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

async function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  relativeDir: string,
  limits: SourceCopyLimits,
  state: CopyState,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = relativeDir === "" ? entry.name : path.join(relativeDir, entry.name);

    // Symlinks are not followed: following them can leave the root, loop, or
    // copy the same bytes twice under a different name.
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        // Dependencies are linked back after the copy so imports still resolve.
        if (entry.name === "node_modules") {
          state.sharedPaths.push(toPosix(relativePath));
        }
        continue;
      }
      await mkdir(path.join(destinationDir, entry.name), { recursive: true });
      await copyDirectory(
        sourcePath,
        path.join(destinationDir, entry.name),
        relativePath,
        limits,
        state,
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.files += 1;
    if (state.files > limits.maxFiles) {
      throw new SourceCopyLimitError(
        `Refusing to copy more than ${limits.maxFiles} file(s) into a disposable workspace. ` +
          "Run against a smaller root, or execute in place with --isolation none.",
        "maxFiles",
      );
    }

    const destinationPath = path.join(destinationDir, entry.name);
    await copyFile(sourcePath, destinationPath);

    const { size } = await stat(destinationPath);
    state.bytes += size;
    if (state.bytes > limits.maxBytes) {
      throw new SourceCopyLimitError(
        `Refusing to copy more than ${Math.floor(limits.maxBytes / (1024 * 1024))} MB into a disposable workspace. ` +
          "Run against a smaller root, or execute in place with --isolation none.",
        "maxBytes",
      );
    }
  }
}

/**
 * Copies `root` into a fresh directory under the OS temp directory.
 *
 * `node_modules` directories are skipped during the copy and re-created as
 * links to the originals, so a package that resolves its own dependencies still
 * works without an install step.
 */
export async function createSourceCopy(
  root: string,
  limits: SourceCopyLimits = DEFAULT_COPY_LIMITS,
): Promise<SourceCopy> {
  const dir = await mkdtemp(path.join(tmpdir(), "codecitadel-copy-"));
  const state: CopyState = { files: 0, bytes: 0, sharedPaths: [] };

  try {
    await copyDirectory(root, dir, "", limits, state);

    for (const relative of state.sharedPaths) {
      const target = path.join(root, relative);
      const link = path.join(dir, relative);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let disposed = false;
  return {
    dir,
    sharedPaths: state.sharedPaths,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

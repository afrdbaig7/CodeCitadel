/**
 * A small, strict unified-diff reader.
 *
 * It exists so a patch can be verified without handing the repository to a Git
 * binary or a shell. The parser owns the refusal half of that promise: paths are
 * relative and validated segment by segment, and binary patches, renames, and
 * file-mode changes are refused rather than approximated, because each can
 * change behaviour in a way this tool would not represent.
 *
 * Application lives in `patch.ts`; nothing here touches the filesystem.
 */

export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** A patch touching more files than this is refused before it is applied. */
export const MAX_PATCH_FILES = 1_000;

/** Raised when the text is not a unified diff this tool understands. */
export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

export interface PatchLine {
  kind: "context" | "added" | "removed";
  text: string;
  /** 1-based line in the original file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line in the patched file, or null for a removed line. */
  newLine: number | null;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface PatchFile {
  /** Null means the file is created by this patch. */
  oldPath: string | null;
  /** Null means the file is deleted by this patch. */
  newPath: string | null;
  hunks: PatchHunk[];
  addedLines: number;
  removedLines: number;
}

export interface ParsedPatch {
  files: PatchFile[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripTimestamp(header: string): string {
  const tab = header.lastIndexOf("\t");
  return (tab === -1 ? header : header.slice(0, tab)).trim();
}

export function validatePatchPath(candidate: string): void {
  if (candidate.length === 0) {
    throw new PatchParseError("The patch names an empty path.");
  }
  if (candidate.includes("\u0000")) {
    throw new PatchParseError("The patch path contains a NUL byte.");
  }
  if (candidate.includes("\\")) {
    throw new PatchParseError(
      `The patch path "${candidate}" uses backslashes. Git diffs use forward slashes on every platform.`,
    );
  }
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    throw new PatchParseError(
      `The patch path "${candidate}" is absolute. Only paths relative to the analyzed root are accepted.`,
    );
  }

  const segments = candidate.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new PatchParseError(
        `The patch path "${candidate}" contains an empty, "." or ".." segment. Paths must stay inside the analyzed root.`,
      );
    }
  }

  const first = segments[0] ?? "";
  if (first === ".git" || first === ".hg" || first === ".svn") {
    throw new PatchParseError(
      `The patch path "${candidate}" points into version-control internals, which are not part of the analyzed source.`,
    );
  }
}

function parseHeaderPath(raw: string): string | null {
  const value = stripTimestamp(raw);
  if (value === "/dev/null") {
    return null;
  }
  if (value.startsWith('"') || value.endsWith('"')) {
    throw new PatchParseError(
      `The patch path ${value} is quoted. Quoted (escaped) paths are not supported; re-create the diff with core.quotePath=false.`,
    );
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    const stripped = value.slice(2);
    validatePatchPath(stripped);
    return stripped;
  }
  validatePatchPath(value);
  return value;
}

function parseHunk(
  lines: readonly string[],
  startIndex: number,
  header: string,
): { hunk: PatchHunk; nextIndex: number } {
  const match = HUNK_HEADER.exec(header);
  if (match === null) {
    throw new PatchParseError(`Malformed hunk header: ${header}`);
  }

  const oldStart = Number(match[1] ?? 0);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3] ?? 0);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);

  const hunkLines: PatchLine[] = [];
  let index = startIndex;
  let oldSeen = 0;
  let newSeen = 0;
  let oldLine = oldStart;
  let newLine = newStart;

  while (oldSeen < oldCount || newSeen < newCount) {
    const body = lines[index];
    if (body === undefined) {
      throw new PatchParseError(
        `A hunk declares ${oldCount} old and ${newCount} new line(s) but the patch ended early.`,
      );
    }
    if (body.startsWith("\\")) {
      index += 1;
      continue;
    }

    // A trailing-space context line is often stripped by editors, so an empty
    // line inside a hunk is read as empty context rather than as a separator.
    const marker = body === "" ? " " : body.charAt(0);
    const content = body === "" ? "" : body.slice(1);

    if (marker === " ") {
      hunkLines.push({ kind: "context", text: content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldSeen += 1;
      newSeen += 1;
    } else if (marker === "-") {
      hunkLines.push({ kind: "removed", text: content, oldLine, newLine: null });
      oldLine += 1;
      oldSeen += 1;
    } else if (marker === "+") {
      hunkLines.push({ kind: "added", text: content, oldLine: null, newLine });
      newLine += 1;
      newSeen += 1;
    } else {
      throw new PatchParseError(
        `A hunk line must start with " ", "-", or "+", found ${JSON.stringify(body.slice(0, 40))}.`,
      );
    }

    if (oldSeen > oldCount || newSeen > newCount) {
      throw new PatchParseError(
        `A hunk contains more lines than its header declares (${oldCount} old, ${newCount} new).`,
      );
    }
    index += 1;
  }

  while (lines[index]?.startsWith("\\") === true) {
    index += 1;
  }

  return { hunk: { oldStart, oldCount, newStart, newCount, lines: hunkLines }, nextIndex: index };
}

/**
 * Reads a unified diff into file changes. The parser accepts what `git diff`
 * writes and refuses the rest with the reason, instead of guessing.
 */
export function parseUnifiedDiff(text: string): ParsedPatch {
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) {
    throw new PatchParseError(
      `The patch is larger than ${Math.floor(MAX_PATCH_BYTES / (1024 * 1024))} MB. Verify a smaller patch, or split it.`,
    );
  }

  const lines = text.split(/\r?\n/);
  const files: PatchFile[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      throw new PatchParseError(
        "The patch contains a binary change. Binary patches are not supported: they cannot be reviewed or context-checked.",
      );
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      throw new PatchParseError(
        "The patch renames a file. Renames are not supported; send a deletion and a creation instead.",
      );
    }
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      throw new PatchParseError("The patch changes file permissions, which this verifier does not apply.");
    }
    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      index += 1;
      continue;
    }
    if (
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ")
    ) {
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (!line.startsWith("--- ")) {
      throw new PatchParseError(
        `Expected a "--- " file header, found ${JSON.stringify(line.slice(0, 60))}.`,
      );
    }

    const plusHeader = lines[index + 1];
    if (plusHeader === undefined || !plusHeader.startsWith("+++ ")) {
      throw new PatchParseError(
        `The "--- " header for ${stripTimestamp(line.slice(4))} is not followed by a "+++ " header.`,
      );
    }

    const oldPath = parseHeaderPath(line.slice(4));
    const newPath = parseHeaderPath(plusHeader.slice(4));
    if (oldPath === null && newPath === null) {
      throw new PatchParseError("A file header names /dev/null on both sides, so it changes nothing.");
    }

    index += 2;
    const hunks: PatchHunk[] = [];
    let addedLines = 0;
    let removedLines = 0;

    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.startsWith("@@ ")) {
        const parsed = parseHunk(lines, index + 1, current);
        hunks.push(parsed.hunk);
        for (const hunkLine of parsed.hunk.lines) {
          if (hunkLine.kind === "added") {
            addedLines += 1;
          } else if (hunkLine.kind === "removed") {
            removedLines += 1;
          }
        }
        index = parsed.nextIndex;
        continue;
      }
      if (
        current.startsWith("--- ") ||
        current.startsWith("diff --git ") ||
        current.startsWith("GIT binary patch") ||
        current.startsWith("Binary files ")
      ) {
        break;
      }
      if (current.trim() === "") {
        index += 1;
        continue;
      }
      throw new PatchParseError(
        `Unexpected line between hunks: ${JSON.stringify(current.slice(0, 60))}.`,
      );
    }

    files.push({ oldPath, newPath, hunks, addedLines, removedLines });
  }

  if (files.length === 0) {
    throw new PatchParseError("The file contains no unified diff: no \"--- \"/\"+++ \" header pair was found.");
  }
  if (files.length > MAX_PATCH_FILES) {
    throw new PatchParseError(
      `The patch touches ${files.length} files, more than the limit of ${MAX_PATCH_FILES}.`,
    );
  }

  return { files };
}

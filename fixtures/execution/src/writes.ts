import { existsSync, writeFileSync } from "node:fs";

/** Name of the file the test writes into its working directory. */
export const MARKER_FILE = "isolation-marker.txt";

/**
 * Writes a marker next to the process working directory and reports whether it
 * is there. The CLI test asserts this file never appears in the analyzed tree:
 * if it does, the run was not isolated.
 */
export function writeMarker(): boolean {
  writeFileSync(MARKER_FILE, "written by a test run\n", "utf8");
  return existsSync(MARKER_FILE);
}

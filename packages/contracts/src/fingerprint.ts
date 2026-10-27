import { createHash } from "node:crypto";

/**
 * The identity of one test across runs: file, full test name, and occurrence.
 *
 * Line numbers never enter the key, so moving a test does not change its id.
 * The test body does not enter either: an edited assertion keeps its id, which
 * is why every consumer that pairs by fingerprint also has to state what the
 * fingerprint does not capture.
 */
export function testFingerprint(file: string, name: string, occurrence = 0): string {
  const digest = createHash("sha256").update(`${file}\u0000${name}\u0000${occurrence}`).digest("hex");
  return `t_${digest.slice(0, 16)}`;
}

/** Shape of every stored test id, so a schema can reject a hand-written id. */
export const TEST_FINGERPRINT_PATTERN = /^t_[0-9a-f]{16}$/;

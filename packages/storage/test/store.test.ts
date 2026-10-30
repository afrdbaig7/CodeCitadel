import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { payloadDigest } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { ReportStore } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-storage-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function storeFile(name: string): string {
  counter += 1;
  return path.join(scratch, `${name}-${counter}`, "evidence.db");
}

function opened(name: string): { store: ReportStore; artifacts: string; file: string } {
  const file = storeFile(name);
  const artifacts = path.join(path.dirname(file), "artifacts");
  return { store: new ReportStore({ file, artifactsDir: artifacts }), artifacts, file };
}

const REPORT = JSON.stringify({ schemaVersion: 1, kind: "impact" });

function insert(store: ReportStore, organizationId: string, name = "checkout") {
  return store.insertRun({
    organizationId,
    repository: { name, commit: "abc123", branch: "main" },
    kind: "impact",
    origin: "local",
    capturedAt: "2026-10-25T09:00:00.000Z",
    receivedAt: "2026-10-25T09:00:01.000Z",
    reportJson: REPORT,
    outcome: "0 test file(s) selected",
    artifacts: [],
  });
}

describe("ReportStore migrations", () => {
  it("applies the history once and reopens at the same version", () => {
    const file = storeFile("migrate");
    const first = new ReportStore({ file, artifactsDir: path.join(scratch, "m1") });
    expect(first.schemaVersion).toBe(2);
    first.close();

    const second = new ReportStore({ file, artifactsDir: path.join(scratch, "m1") });
    expect(second.schemaVersion).toBe(2);
    second.close();
  });
});

describe("tokens", () => {
  it("authenticates the token it issued and nothing else", () => {
    const { store } = opened("token");
    const org = store.ensureOrganization("acme");
    store.issueToken({ organizationId: org.id, token: "cc_secret_one", label: "ci" });

    expect(store.authenticate("cc_secret_one")).toEqual({ ...org, role: "admin", issuer: null, subject: null });
    expect(store.authenticate("cc_secret_two")).toBeNull();
    store.close();
  });

  it("never writes the plaintext token to the database file", () => {
    const { store, file } = opened("token-hash");
    const org = store.ensureOrganization("acme");
    store.issueToken({ organizationId: org.id, token: "cc_plaintext_must_not_appear", label: "ci" });
    store.close();

    const bytes = readFileSync(file);
    expect(bytes.includes("cc_plaintext_must_not_appear")).toBe(false);
  });
});

describe("tenant scoping", () => {
  it("returns the run to its own organization only", () => {
    const { store } = opened("tenant");
    const acme = store.ensureOrganization("acme");
    const other = store.ensureOrganization("other");
    const run = insert(store, acme.id);

    expect(store.getRun(acme.id, run.id)?.run.id).toBe(run.id);
    expect(store.getRun(other.id, run.id)).toBeNull();
    expect(store.listRuns(other.id)).toEqual([]);
    expect(store.listRuns(acme.id).map((entry) => entry.id)).toEqual([run.id]);
    store.close();
  });

  it("creates one repository row per tenant and name", () => {
    const { store } = opened("repositories");
    const acme = store.ensureOrganization("acme");
    const first = insert(store, acme.id);
    const second = insert(store, acme.id);
    expect(first.repository.id).toBe(second.repository.id);
    store.close();
  });

  it("records the report digest over the exact stored bytes", () => {
    const { store } = opened("digest");
    const acme = store.ensureOrganization("acme");
    const run = insert(store, acme.id);
    expect(run.reportDigest).toBe(payloadDigest(Buffer.from(REPORT, "utf8")));
    expect(run.bytes).toBe(Buffer.byteLength(REPORT, "utf8"));
    store.close();
  });
});

describe("artifacts", () => {
  it("stores and reads an artifact back with its digest", () => {
    const { store } = opened("artifact");
    const acme = store.ensureOrganization("acme");
    const content = Buffer.from("assertion trace\n", "utf8");
    const run = store.insertRun({
      organizationId: acme.id,
      repository: { name: "checkout", commit: null, branch: null },
      kind: "impact",
      origin: "user-ci",
      capturedAt: "2026-10-25T09:00:00.000Z",
      receivedAt: "2026-10-25T09:00:01.000Z",
      reportJson: REPORT,
      outcome: null,
      artifacts: [{ name: "trace.txt", digest: payloadDigest(content), bytes: content }],
    });

    expect(run.artifacts).toEqual([
      { name: "trace.txt", digest: payloadDigest(content), bytes: content.length },
    ]);
    const read = store.readArtifact(acme.id, run.id, "trace.txt");
    expect(read?.bytes.toString("utf8")).toBe("assertion trace\n");
    store.close();
  });

  it("refuses an artifact name that is not a safe file name", () => {
    const { store } = opened("artifact-name");
    const acme = store.ensureOrganization("acme");
    expect(() =>
      store.insertRun({
        organizationId: acme.id,
        repository: { name: "checkout", commit: null, branch: null },
        kind: "impact",
        origin: "local",
        capturedAt: "2026-10-25T09:00:00.000Z",
        receivedAt: "2026-10-25T09:00:01.000Z",
        reportJson: REPORT,
        outcome: null,
        artifacts: [{ name: "../escape.txt", digest: payloadDigest("x"), bytes: Buffer.from("x") }],
      }),
    ).toThrow(/safe file name/);
    store.close();
  });

  it("does not serve an artifact to another tenant", () => {
    const { store } = opened("artifact-tenant");
    const acme = store.ensureOrganization("acme");
    const other = store.ensureOrganization("other");
    const content = Buffer.from("trace", "utf8");
    const run = store.insertRun({
      organizationId: acme.id,
      repository: { name: "checkout", commit: null, branch: null },
      kind: "impact",
      origin: "local",
      capturedAt: "2026-10-25T09:00:00.000Z",
      receivedAt: "2026-10-25T09:00:01.000Z",
      reportJson: REPORT,
      outcome: null,
      artifacts: [{ name: "trace.txt", digest: payloadDigest(content), bytes: content }],
    });

    expect(store.readArtifact(other.id, run.id, "trace.txt")).toBeNull();
    store.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_UPLOAD_BYTES,
  apiErrorSchema,
  healthResponseSchema,
  payloadDigest,
  runDetailResponseSchema,
  runListResponseSchema,
  uploadResponseSchema,
} from "@codecitadel/contracts";
import { ReportStore } from "@codecitadel/storage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-api-"));
let app: FastifyInstance;
let store: ReportStore;
let acme: { id: string; slug: string };
let other: { id: string; slug: string };
const ACME_TOKEN = "cc_acme_token";
const OTHER_TOKEN = "cc_other_token";

const IMPACT = {
  schemaVersion: 1,
  generatedAt: "2026-10-25T09:00:00.000Z",
  root: "/repo",
  base: { generatedAt: "2026-10-24T09:00:00.000Z", root: "/repo" },
  changed: [],
  graph: {
    modules: 0,
    edges: 0,
    testFiles: 0,
    externalImports: 0,
    outsideScope: 0,
    unresolved: [],
  },
  impacted: [],
  tests: { selected: [], notSelected: 0 },
  complete: true,
  incompleteReasons: [],
  limitations: ["No file changed, so no test was selected."],
};

function upload(overrides: Record<string, unknown> = {}, token = ACME_TOKEN) {
  return app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      schemaVersion: 1,
      origin: "local",
      kind: "impact",
      repository: { name: "checkout", commit: "abc123", branch: "main" },
      capturedAt: "2026-10-25T09:00:02.000Z",
      report: IMPACT,
      artifacts: [],
      ...overrides,
    },
  });
}

beforeAll(() => {
  store = new ReportStore({
    file: path.join(scratch, "evidence.db"),
    artifactsDir: path.join(scratch, "artifacts"),
  });
  acme = store.ensureOrganization("acme");
  other = store.ensureOrganization("other");
  store.issueToken({ organizationId: acme.id, token: ACME_TOKEN, label: "acme" });
  store.issueToken({ organizationId: other.id, token: OTHER_TOKEN, label: "other" });
  app = buildServer({ store });
});

afterAll(async () => {
  await app.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("health", () => {
  it("reports the storage driver and what it does not do", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.storage.driver).toBe("sqlite");
    expect(body.limitations.join(" ")).toContain("user-controlled evidence");
  });
});

describe("authentication", () => {
  it("refuses a request without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unauthorized");
  });

  it("refuses an unknown token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("upload", () => {
  it("stores a validated report and returns it as evidence", async () => {
    const response = await upload();
    expect(response.statusCode).toBe(202);
    const body = uploadResponseSchema.parse(response.json());
    expect(body.run.kind).toBe("impact");
    expect(body.run.origin).toBe("local");
    expect(body.run.organizationId).toBe(acme.id);
    expect(body.run.outcome).toBe("0 test file(s) selected");
    expect(body.run.reportDigest).toBe(payloadDigest(JSON.stringify(IMPACT)));
  });

  it("rejects an upload whose envelope is incomplete", async () => {
    const response = await upload({ capturedAt: undefined });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
  });

  it("rejects a report that does not match the declared kind", async () => {
    const response = await upload({ kind: "scan" });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unsupported_kind");
  });

  it("rejects an artifact whose bytes do not match its digest", async () => {
    const response = await upload({
      artifacts: [
        {
          name: "trace.txt",
          digest: payloadDigest("someone else's bytes"),
          contentBase64: Buffer.from("actual bytes").toString("base64"),
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("does not match its digest");
  });

  it("refuses a body over the upload limit", async () => {
    const oversized = "x".repeat(MAX_UPLOAD_BYTES + 1024);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { authorization: `Bearer ${ACME_TOKEN}`, "content-type": "application/json" },
      payload: `{"padding":"${oversized}"}`,
    });
    expect(response.statusCode).toBe(413);
  });
});

describe("reads", () => {
  it("lists and returns the stored report unchanged", async () => {
    const created = uploadResponseSchema.parse((await upload()).json());
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/runs?limit=10",
      headers: { authorization: `Bearer ${ACME_TOKEN}` },
    });
    expect(list.statusCode).toBe(200);
    const runs = runListResponseSchema.parse(list.json()).runs;
    expect(runs.some((run) => run.id === created.run.id)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.run.id}`,
      headers: { authorization: `Bearer ${ACME_TOKEN}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(runDetailResponseSchema.parse(detail.json()).report).toEqual(IMPACT);
  });

  it("round-trips an artifact with its digest header", async () => {
    const content = Buffer.from("first failure trace\n", "utf8");
    const created = uploadResponseSchema.parse(
      (
        await upload({
          artifacts: [
            {
              name: "trace.txt",
              digest: payloadDigest(content),
              contentBase64: content.toString("base64"),
            },
          ],
        })
      ).json(),
    );
    expect(created.run.artifacts).toHaveLength(1);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.run.id}/artifacts/trace.txt`,
      headers: { authorization: `Bearer ${ACME_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-codecitadel-digest"]).toBe(payloadDigest(content));
    expect(response.rawPayload.toString("utf8")).toBe("first failure trace\n");
  });
});

describe("tenant isolation", () => {
  it("hides another organization's run behind a 404", async () => {
    const created = uploadResponseSchema.parse((await upload()).json());

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.run.id}`,
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(detail.statusCode).toBe(404);

    const artifact = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.run.id}/artifacts/trace.txt`,
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(artifact.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(runListResponseSchema.parse(list.json()).runs).toEqual([]);
  });
});

describe("unknown routes", () => {
  it("answers with the versioned error shape", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("not_found");
  });
});

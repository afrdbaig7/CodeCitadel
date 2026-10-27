import { describe, expect, it } from "vitest";

import { DEMO_REPORT_SCHEMA_VERSION, demoReportSchema, type DemoReport } from "../src/index.js";

function validReport(overrides: Partial<DemoReport> = {}): DemoReport {
  return {
    schemaVersion: DEMO_REPORT_SCHEMA_VERSION,
    generatedAt: "2026-10-26T12:00:00.000Z",
    demo: "coupon-race",
    project: "D:/repo/examples/shopping-api",
    workCopy: "(removed)",
    database: {
      mode: "container",
      container: "codecitadel-demo-coupon-race-ab12cd34",
      host: "127.0.0.1",
      port: 55432,
      database: "codecitadel",
      serverVersion: "PostgreSQL 16.15",
    },
    acts: [
      { id: "database", status: "performed", detail: "started postgres:16-alpine on 127.0.0.1:55432." },
      { id: "teardown", status: "performed", detail: "removed the container and the copy." },
    ],
    requirement: { id: "coupon.single-redemption", status: "recorded", digest: "sha256:" + "a".repeat(64) },
    reproduction: {
      id: "coupon.concurrent-redemption",
      verdict: "reproduced",
      report: "D:/repo/.codecitadel/demo/coupon-race/reproduction.json",
    },
    patch: {
      verdict: "verified",
      digest: "sha256:" + "b".repeat(64),
      report: "D:/repo/.codecitadel/demo/coupon-race/patch-verify.json",
    },
    outcome: "demonstrated",
    limitations: ["Everything ran inside a disposable copy of the project."],
    ...overrides,
  };
}

describe("demoReportSchema", () => {
  it("accepts a complete report and keeps its outcome and verdicts", () => {
    const parsed = demoReportSchema.parse(validReport());
    expect(parsed.demo).toBe("coupon-race");
    expect(parsed.outcome).toBe("demonstrated");
    expect(parsed.reproduction?.verdict).toBe("reproduced");
    expect(parsed.patch?.verdict).toBe("verified");
    expect(parsed.acts.map((act) => act.status)).toEqual(["performed", "performed"]);
  });

  it("rejects an outcome the verdict vocabulary does not contain", () => {
    const result = demoReportSchema.safeParse(validReport({ outcome: "looks-good" as never }));
    expect(result.success).toBe(false);
  });

  it("refuses to claim a demonstration without the evidence it rests on", () => {
    const noEvidence = demoReportSchema.safeParse(
      validReport({ reproduction: null, patch: null }),
    );
    expect(noEvidence.success).toBe(false);

    const wrongPatch = demoReportSchema.safeParse(
      validReport({ patch: { verdict: "not_verified", digest: "sha256:" + "b".repeat(64), report: "x.json" } }),
    );
    expect(wrongPatch.success).toBe(false);

    const inconclusive = demoReportSchema.safeParse(
      validReport({ outcome: "inconclusive", reproduction: null, patch: null }),
    );
    expect(inconclusive.success).toBe(true);
    expect(inconclusive.success && inconclusive.data.reproduction).toBeNull();
  });

  it("refuses a limitations list, because an unexplained demo is not evidence", () => {
    const result = demoReportSchema.safeParse(validReport({ limitations: [] }));
    expect(result.success).toBe(false);
  });

  it("refuses a version this build does not understand", () => {
    const result = demoReportSchema.safeParse(
      validReport({ schemaVersion: 99 as never }),
    );
    expect(result.success).toBe(false);
  });

  it("never carries a credential: the database record names host, port, and container", () => {
    const parsed = demoReportSchema.parse(validReport());
    const serialized = JSON.stringify(parsed.database);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("password");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TestResult, TestRunReport } from "@codecitadel/contracts";
import {
  requirementDocumentSchema,
  requirementsEvaluationSchema,
  testFingerprint,
  type RequirementDocument,
} from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import {
  acceptanceStatusOf,
  acceptRequirement,
  evaluateRequirements,
  parseRequirementDocument,
  RequirementDocumentError,
  summarizeRequirements,
} from "../src/requirements.js";

const GENERATED_AT = "2026-10-23T00:00:00.000Z";
const ROOT = "/repo";

const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/requirements/codecitadel.requirements.json", import.meta.url),
);

function fixtureDocument(): RequirementDocument {
  return requirementDocumentSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

function result(
  file: string,
  name: string,
  status: TestResult["status"],
  message: string | null = null,
): TestResult {
  return {
    id: testFingerprint(file, name),
    file,
    name,
    status,
    durationMs: 3,
    message,
  };
}

function report(results: TestResult[], status: TestRunReport["record"]["status"] = "passed"): TestRunReport {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    root: ROOT,
    impact: {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      root: ROOT,
      base: { generatedAt: GENERATED_AT, root: ROOT },
      changed: [{ path: "src/coupon.ts", change: "modified" }],
      graph: {
        modules: 1,
        edges: 1,
        testFiles: 1,
        externalImports: 0,
        outsideScope: 0,
        unresolved: [],
      },
      impacted: [],
      tests: {
        selected: [
          {
            path: "src/coupon.test.ts",
            depth: 1,
            chain: [
              { path: "src/coupon.ts", relation: "changed" },
              { path: "src/coupon.test.ts", relation: "imports" },
            ],
          },
        ],
        notSelected: 0,
      },
      complete: true,
      incompleteReasons: [],
      limitations: ["Import reachability is not semantics."],
    },
    record: {
      id: "run_0123456789abcdef",
      runner: "vitest",
      runnerVersion: "3.2.4",
      nodeVersion: "22.11.0",
      platform: "win32-x64",
      status,
      exitCode: status === "passed" ? 0 : 1,
      durationMs: 40,
      startedAt: GENERATED_AT,
      command: ["node", "vitest", "run", "src/coupon.test.ts"],
      counts: {
        passed: results.filter((entry) => entry.status === "passed").length,
        failed: results.filter((entry) => entry.status === "failed").length,
        skipped: 0,
        timedOut: 0,
        errored: 0,
        cancelled: 0,
        unsupported: 0,
        total: results.length,
      },
      isolation: {
        mode: "source-copy",
        root: "/tmp/codecitadel-copy",
        sharedPaths: ["node_modules"],
        limitations: ["The copy shares node_modules with the checkout."],
      },
      detail: null,
    },
    results,
    limitations: ["A pass covers only the selected tests in this environment."],
  };
}

function acceptedCouponDocument(): RequirementDocument {
  return acceptRequirement({
    document: fixtureDocument(),
    id: "coupon.single-redemption",
    acceptedBy: "tester",
    at: new Date(GENERATED_AT),
  });
}

const FIRST_USE = result("src/coupon.test.ts", "coupon > a user redeems a coupon once", "passed");
const REPEATED_USE = result(
  "src/coupon.test.ts",
  "coupon > a repeated redemption is rejected",
  "passed",
);

describe("requirement documents", () => {
  it("parses the fixture and reports proposed requirements as not accepted", () => {
    const document = parseRequirementDocument(readFileSync(FIXTURE, "utf8"));
    const summary = summarizeRequirements(document);
    expect(summary.counts).toMatchObject({ accepted: 0, stale: 0, proposed: 2, total: 2 });
    expect(summary.requirements[0]?.acceptance).toBe("missing");
    expect(summary.requirements[0]?.checks[0]?.fingerprint).toBe(
      testFingerprint("src/coupon.test.ts", "coupon > a user redeems a coupon once"),
    );
  });

  it("rejects an unknown field instead of ignoring a typo", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.requirements[0].statment = "typo";
    expect(() => parseRequirementDocument(JSON.stringify(raw))).toThrow(RequirementDocumentError);
  });

  it("rejects a document version it does not understand", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.schemaVersion = 2;
    expect(() => parseRequirementDocument(JSON.stringify(raw))).toThrow(/schema version 1/);
  });

  it("rejects duplicate requirement ids", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.requirements.push(raw.requirements[0]);
    expect(() => parseRequirementDocument(JSON.stringify(raw))).toThrow(/duplicate requirement id/);
  });

  it("requires an acceptance record for an accepted requirement", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.requirements[0].state = "accepted";
    expect(() => parseRequirementDocument(JSON.stringify(raw))).toThrow(
      /needs an acceptance record/,
    );
  });

  it("rejects an acceptance record on a proposed requirement", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.requirements[0].acceptance = {
      acceptedAt: GENERATED_AT,
      acceptedBy: "tester",
      digest: `sha256:${"0".repeat(64)}`,
    };
    expect(() => parseRequirementDocument(JSON.stringify(raw))).toThrow(
      /only an accepted requirement/,
    );
  });
});

describe("requirement acceptance", () => {
  it("records the accepter, the time, and a digest over the text", () => {
    const document = acceptedCouponDocument();
    const requirement = document.requirements[0];
    expect(requirement?.state).toBe("accepted");
    expect(requirement?.acceptance).toMatchObject({ acceptedAt: GENERATED_AT, acceptedBy: "tester" });
    expect(acceptanceStatusOf(requirement!)).toBe("current");
  });

  it("goes stale when the statement is edited after acceptance", () => {
    const document = acceptedCouponDocument();
    const edited = {
      ...document.requirements[0]!,
      statement: "A coupon can be redeemed twice per user.",
    };
    expect(acceptanceStatusOf(edited)).toBe("stale");
  });

  it("goes stale when a check is edited after acceptance", () => {
    const document = acceptedCouponDocument();
    const requirement = document.requirements[0]!;
    const edited = {
      ...requirement,
      checks: [
        requirement.checks[0]!,
        { ...requirement.checks[1]!, name: "coupon > a repeated redemption is allowed" },
      ],
    };
    expect(acceptanceStatusOf(edited)).toBe("stale");
  });

  it("refuses an unknown id and an anonymous acceptance", () => {
    const document = fixtureDocument();
    expect(() =>
      acceptRequirement({ document, id: "coupon.unknown", acceptedBy: "tester" }),
    ).toThrow(RequirementDocumentError);
    expect(() =>
      acceptRequirement({ document, id: "coupon.single-redemption", acceptedBy: "  " }),
    ).toThrow(/non-empty --by/);
  });
});

describe("requirement evaluation", () => {
  it("is met only when every registered check passed", () => {
    const evaluation = evaluateRequirements({
      document: acceptedCouponDocument(),
      report: report([FIRST_USE, REPEATED_USE]),
      generatedAt: new Date(GENERATED_AT),
    });
    const coupon = evaluation.requirements.find((entry) => entry.id === "coupon.single-redemption");
    expect(coupon?.verdict).toBe("met");
    expect(coupon?.checks.map((check) => check.outcome)).toEqual(["passed", "passed"]);

    const token = evaluation.requirements.find((entry) => entry.id === "token.expiry-boundary");
    expect(token?.verdict).toBe("not_accepted");
    expect(token?.checks[0]?.outcome).toBe("not_run");
    expect(evaluation.counts).toMatchObject({ met: 1, unmet: 0, inconclusive: 0, notAccepted: 1 });
    expect(requirementsEvaluationSchema.parse(evaluation).counts.total).toBe(2);
  });

  it("is unmet when a registered check failed, and keeps the failure message", () => {
    const failing = result(
      "src/coupon.test.ts",
      "coupon > a repeated redemption is rejected",
      "failed",
      "expected 400, received 200",
    );
    const evaluation = evaluateRequirements({
      document: acceptedCouponDocument(),
      report: report([FIRST_USE, failing], "failed"),
    });
    const coupon = evaluation.requirements[0]!;
    expect(coupon.verdict).toBe("unmet");
    expect(coupon.checks[1]).toMatchObject({
      outcome: "failed",
      status: "failed",
      message: "expected 400, received 200",
    });
  });

  it("is inconclusive when a check did not run or produced no evidence", () => {
    for (const outcome of ["missing", "skipped", "errored"] as const) {
      const second =
        outcome === "missing"
          ? []
          : [
              result(
                "src/coupon.test.ts",
                "coupon > a repeated redemption is rejected",
                outcome,
              ),
            ];
      const evaluation = evaluateRequirements({
        document: acceptedCouponDocument(),
        report: report([FIRST_USE, ...second]),
      });
      expect(evaluation.requirements[0]?.verdict).toBe("inconclusive");
    }
  });

  it("never satisfies a requirement whose acceptance is stale", () => {
    const document = acceptedCouponDocument();
    const stale: RequirementDocument = {
      ...document,
      requirements: [
        { ...document.requirements[0]!, statement: "A coupon is always redeemable." },
        document.requirements[1]!,
      ],
    };
    const evaluation = evaluateRequirements({
      document: stale,
      report: report([FIRST_USE, REPEATED_USE]),
    });
    expect(evaluation.requirements[0]).toMatchObject({
      verdict: "not_accepted",
      acceptance: "stale",
    });
    expect(evaluation.limitations.join(" ")).toContain("not accepted under its current text");
  });

  it("does not count a proposed requirement as met even when its checks pass", () => {
    const evaluation = evaluateRequirements({
      document: fixtureDocument(),
      report: report([FIRST_USE, REPEATED_USE]),
    });
    expect(evaluation.requirements.every((entry) => entry.verdict === "not_accepted")).toBe(true);
    expect(evaluation.counts.met).toBe(0);
  });
});

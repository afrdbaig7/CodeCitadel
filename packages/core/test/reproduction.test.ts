import type { ReproductionRequirement, TestResult } from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import {
  decideReproductionVerdict,
  findReproduction,
  parseReproductionDocument,
  ReproductionError,
  validateReproductionPath,
} from "../src/reproduction.js";

const document = {
  schemaVersion: 1 as const,
  reproductions: [
    {
      id: "coupon.double-redemption",
      requirement: "coupon.single-redemption" as string | null,
      statement: "A second redemption by the same user is rejected.",
      provenance: "user-authored" as const,
      file: "reproductions/coupon.test.ts",
      test: "coupon a repeated redemption is rejected",
    },
    {
      id: "math.negative-sum",
      requirement: null,
      statement: "add returns the arithmetic sum for negative operands.",
      provenance: "user-authored" as const,
      file: "reproductions/math.test.ts",
      test: "math adds negative numbers",
    },
  ],
};

const TEXT = JSON.stringify(document);

function result(status: TestResult["status"]): TestResult {
  return {
    id: "t_0123456789abcdef",
    file: "reproductions/math.test.ts",
    name: "math adds negative numbers",
    status,
    durationMs: 3,
    message: status === "failed" ? "AssertionError: expected -3 to be -4" : null,
  };
}

const ACCEPTED: ReproductionRequirement = {
  id: "coupon.single-redemption",
  state: "accepted",
  acceptance: "current",
};

describe("parseReproductionDocument", () => {
  it("reads a valid manifest", () => {
    expect(parseReproductionDocument(TEXT).reproductions).toHaveLength(2);
  });

  it("reports invalid JSON with the source it was reading", () => {
    expect(() => parseReproductionDocument("{", "manifest.json")).toThrow(
      /manifest\.json is not valid JSON/,
    );
  });

  it("rejects an unknown field at the exact path", () => {
    const broken = JSON.parse(TEXT) as { reproductions: Record<string, unknown>[] };
    broken.reproductions[0]!.testName = "typo";
    expect(() => parseReproductionDocument(JSON.stringify(broken))).toThrow(
      /reproductions\.0: .*unrecognized|reproductions\.0/,
    );
  });

  it("rejects duplicate ids", () => {
    const broken = {
      schemaVersion: 1,
      reproductions: [document.reproductions[0], document.reproductions[0]],
    };
    expect(() => parseReproductionDocument(JSON.stringify(broken))).toThrow(/duplicate/);
  });
});

describe("findReproduction", () => {
  it("selects the declared entry", () => {
    const entry = findReproduction(parseReproductionDocument(TEXT), "math.negative-sum");
    expect(entry.test).toBe("math adds negative numbers");
  });

  it("names the known ids when the requested one is absent", () => {
    expect(() =>
      findReproduction(parseReproductionDocument(TEXT), "missing.one"),
    ).toThrow(/coupon\.double-redemption, math\.negative-sum/);
  });
});

describe("validateReproductionPath", () => {
  it("accepts a relative forward-slash path", () => {
    expect(() => validateReproductionPath("reproductions/coupon.test.ts")).not.toThrow();
  });

  it("refuses traversal, absolute, and Windows paths", () => {
    for (const candidate of [
      "../outside.test.ts",
      "reproductions/../../outside.test.ts",
      "/etc/passwd",
      "C:/checkout/src/x.test.ts",
      "reproductions\\coupon.test.ts",
      "reproductions//coupon.test.ts",
      "./reproductions/coupon.test.ts",
      "",
    ]) {
      expect(() => validateReproductionPath(candidate), candidate).toThrow(ReproductionError);
    }
  });
});

describe("decideReproductionVerdict", () => {
  it("refuses a reproduction for a requirement nobody accepted", () => {
    const decision = decideReproductionVerdict({
      requirement: { ...ACCEPTED, state: "proposed", acceptance: "missing" },
      executionStatus: null,
      result: null,
    });
    expect(decision.verdict).toBe("not_accepted");
    expect(decision.reason).toContain("proposed");
  });

  it("refuses a reproduction whose acceptance went stale", () => {
    const decision = decideReproductionVerdict({
      requirement: { ...ACCEPTED, acceptance: "stale" },
      executionStatus: null,
      result: null,
    });
    expect(decision.verdict).toBe("not_accepted");
    expect(decision.reason).toContain("edited");
  });

  it("never turns a missing execution into evidence", () => {
    const decision = decideReproductionVerdict({
      requirement: null,
      executionStatus: null,
      result: null,
      notExecutedReason: "Nothing ran.",
    });
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reason).toBe("Nothing ran.");
  });

  it("treats a run that did not finish as inconclusive, not as a failure", () => {
    for (const status of ["timed_out", "errored", "cancelled", "unsupported"] as const) {
      const decision = decideReproductionVerdict({
        requirement: null,
        executionStatus: status,
        result: null,
      });
      expect(decision.verdict, status).toBe("inconclusive");
      expect(decision.reason).toContain(status);
    }
  });

  it("does not accept a missing result as a pass", () => {
    const decision = decideReproductionVerdict({
      requirement: null,
      executionStatus: "passed",
      result: null,
    });
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reason).toContain("no result");
  });

  it("calls a failed assertion reproduced", () => {
    const decision = decideReproductionVerdict({
      requirement: ACCEPTED,
      executionStatus: "failed",
      result: result("failed"),
    });
    expect(decision.verdict).toBe("reproduced");
  });

  it("calls a passing check not reproduced and says what that does not prove", () => {
    const decision = decideReproductionVerdict({
      requirement: ACCEPTED,
      executionStatus: "passed",
      result: result("passed"),
    });
    expect(decision.verdict).toBe("not_reproduced");
    expect(decision.reason).toContain("not proof");
  });

  it("keeps a skipped named test inconclusive", () => {
    const decision = decideReproductionVerdict({
      requirement: null,
      executionStatus: "passed",
      result: result("skipped"),
    });
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reason).toContain("skipped");
  });
});

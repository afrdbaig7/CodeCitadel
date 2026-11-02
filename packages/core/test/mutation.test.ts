import { describe, expect, it } from "vitest";

import {
  discoverMutantsInContent,
  MUTATION_OPERATORS,
} from "../src/mutation.js";

describe("Mutation operator unit tests", () => {
  it("discovers equality operators and creates inverse mutants", () => {
    const code = `
      function isEligible(age: number) {
        if (age === 18) return true;
        if (age !== 21) return false;
        return age == 10;
      }
    `;
    const mutants = discoverMutantsInContent("src/auth.ts", code);
    expect(mutants.length).toBeGreaterThanOrEqual(3);

    const eqMutant = mutants.find((m) => m.original === "===");
    expect(eqMutant).toBeDefined();
    expect(eqMutant?.replacement).toBe("!==");
    expect(eqMutant?.mutatorName).toBe("EqualityOperator");
    expect(eqMutant?.diff).toContain("-        if (age === 18) return true;");
    expect(eqMutant?.diff).toContain("+        if (age !== 18) return true;");

    const neqMutant = mutants.find((m) => m.original === "!==");
    expect(neqMutant?.replacement).toBe("===");

    const looseEqMutant = mutants.find((m) => m.original === "==");
    expect(looseEqMutant?.replacement).toBe("!=");
  });

  it("discovers comparison operators", () => {
    const code = `
      function checkBounds(x: number) {
        if (x > 10) return true;
        if (x <= 5) return false;
      }
    `;
    const mutants = discoverMutantsInContent("src/bounds.ts", code);
    const gtMutant = mutants.find((m) => m.original === ">");
    expect(gtMutant?.replacement).toBe("<=");

    const lteMutant = mutants.find((m) => m.original === "<=");
    expect(lteMutant?.replacement).toBe(">");
  });

  it("discovers arithmetic operators", () => {
    const code = `
      function compute(a: number, b: number) {
        const sum = a + b;
        const product = a * b;
        return sum - product;
      }
    `;
    const mutants = discoverMutantsInContent("src/math.ts", code);
    const addMutant = mutants.find((m) => m.original === "+");
    expect(addMutant?.replacement).toBe("-");

    const mulMutant = mutants.find((m) => m.original === "*");
    expect(mulMutant?.replacement).toBe("/");
  });

  it("discovers boolean literals and ignores comments/imports", () => {
    const code = `
      // import something from "somewhere"
      // const commented = true;
      import { something } from "./module";
      export interface Config { debug: boolean; }
      function getConfig() {
        return true;
      }
    `;
    const mutants = discoverMutantsInContent("src/config.ts", code);
    expect(mutants).toHaveLength(1);
    expect(mutants[0].original).toBe("true");
    expect(mutants[0].replacement).toBe("false");
    expect(mutants[0].mutatorName).toBe("BooleanLiteral");
  });
});

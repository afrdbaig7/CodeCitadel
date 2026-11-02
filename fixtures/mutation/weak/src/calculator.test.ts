import { describe, expect, it } from "vitest";
import { calculateDiscount } from "./calculator.js";

describe("calculator (weak test suite)", () => {
  it("executes calculateDiscount without throwing", () => {
    const result = calculateDiscount(150);
    // Weak test smell: asserts only the type, so mutant (* -> / or >= -> <) survives!
    expect(typeof result).toBe("number");
  });
});

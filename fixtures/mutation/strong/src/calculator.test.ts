import { describe, expect, it } from "vitest";
import { calculateDiscount } from "./calculator.js";

describe("calculator (strong test suite)", () => {
  it("applies 20% discount for orders at or above 100", () => {
    expect(calculateDiscount(100)).toBe(80);
    expect(calculateDiscount(200)).toBe(160);
  });

  it("applies zero discount for orders under 100", () => {
    expect(calculateDiscount(0)).toBe(0);
    expect(calculateDiscount(50)).toBe(50);
    expect(calculateDiscount(99)).toBe(99);
  });
});

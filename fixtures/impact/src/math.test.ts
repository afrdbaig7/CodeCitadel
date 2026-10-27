import { expect, it } from "vitest";

import { add, multiply } from "./math";

it("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});

it("multiplies two numbers", () => {
  expect(multiply(2, 3)).toBe(6);
});

import { expect, it } from "vitest";

import { formatCurrency } from "./format";

it("formats USD", () => {
  expect(formatCurrency(10)).toBe("$10.00");
});

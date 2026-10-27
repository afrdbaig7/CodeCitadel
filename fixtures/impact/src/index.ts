import { formatCurrency } from "./format";
import { add } from "./math";

export function describeTotal(left: number, right: number): string {
  return formatCurrency(add(left, right));
}

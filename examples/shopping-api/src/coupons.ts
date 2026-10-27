import type { Pool } from "pg";

export interface RedeemCouponInput {
  userId: string;
  code: string;
}

export type RedeemCouponOutcome =
  | { status: "redeemed"; redemptionId: string }
  | { status: "already_redeemed" }
  | { status: "unknown_coupon" };

/**
 * The accepted rule this fixture is about: a coupon can be redeemed at most once
 * per user.
 *
 * DELIBERATELY VULNERABLE. The check and the insert are two separate statements
 * with no transaction isolation above `read committed` and no uniqueness
 * constraint behind them. Two requests that both run the check before either
 * insert both see "not redeemed yet" and both insert, so a single user can
 * redeem one coupon twice. The fix is a composite unique constraint on
 * `redemptions (user_id, coupon_id)` plus conflict handling in this function,
 * not a longer lock here; the demonstration is what proves that.
 */
export async function redeemCoupon(
  pool: Pool,
  input: RedeemCouponInput,
): Promise<RedeemCouponOutcome> {
  const coupon = await pool.query<{ id: string }>("select id from coupons where code = $1", [
    input.code,
  ]);
  const couponRow = coupon.rows[0];
  if (couponRow === undefined) {
    return { status: "unknown_coupon" };
  }

  const existing = await pool.query<{ id: string }>(
    "select id from redemptions where user_id = $1 and coupon_id = $2",
    [input.userId, couponRow.id],
  );
  if (existing.rows.length > 0) {
    return { status: "already_redeemed" };
  }

  await demoHoldAtCheckInsertBoundary();

  const inserted = await pool.query<{ id: string }>(
    "insert into redemptions (user_id, coupon_id) values ($1, $2) returning id",
    [input.userId, couponRow.id],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow === undefined) {
    throw new Error("The redemption insert returned no row.");
  }

  return { status: "redeemed", redemptionId: insertedRow.id };
}

/**
 * Name of the explicitly labeled demonstration hook. It exists only so the race
 * can be shown repeatably instead of depending on how the event loop happens to
 * schedule two requests. It is off unless an operator sets it.
 *
 * This is a test hook, not evidence of how often the race happens in
 * production: a run that needs the hook must say so.
 */
export const DEMO_HOLD_ENV = "CODECITADEL_DEMO_HOLD_MS";

/** Widest hold the hook accepts; a larger value is clamped so a typo cannot hang a run. */
export const DEMO_HOLD_LIMIT_MS = 2_000;

async function demoHoldAtCheckInsertBoundary(): Promise<void> {
  const raw = process.env[DEMO_HOLD_ENV];
  if (raw === undefined || raw === "") {
    return;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return;
  }
  const holdMs = Math.min(Math.trunc(parsed), DEMO_HOLD_LIMIT_MS);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
}

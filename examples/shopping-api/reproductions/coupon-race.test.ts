/**
 * The reproduction for "a coupon can be redeemed only once per user".
 *
 * THIS CHECK IS EXPECTED TO FAIL ON THIS CHECKOUT. That is its job: the demo's
 * claim is that concurrent redemptions of one coupon by one user are accepted
 * twice, and a check that passed here would be evidence the claim is wrong.
 *
 * It is not part of `npm test` (that script runs `test/` only) because a suite
 * that is green by definition proves nothing. Run it on its own with
 * `npm run test:reproduction`, or through CodeCitadel:
 *
 *   codecitadel reproduce run codecitadel.reproductions.json . --id coupon.concurrent-redemption
 *
 * The concurrency is synchronized with the explicitly labeled demonstration hook
 * `CODECITADEL_DEMO_HOLD_MS`, which pauses between the check and the insert. The
 * hook makes the race repeatable; it is not evidence of how often this happens
 * without a hook, and a report that relies on it must say so.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_HOLD_ENV } from "../src/coupons.ts";
import { buildServer } from "../src/server.ts";

import {
  countRedemptions,
  createDisposableDatabase,
  seedCoupon,
  seedUser,
  type DisposableDatabase,
} from "../test/helpers/database.ts";

const CONCURRENT_REQUESTS = 8;

describe("coupon", () => {
  let db: DisposableDatabase;
  let app: ReturnType<typeof buildServer>;
  const previousHold = process.env[DEMO_HOLD_ENV];

  beforeAll(async () => {
    db = await createDisposableDatabase();
    app = buildServer(db.pool);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
    if (previousHold === undefined) {
      delete process.env[DEMO_HOLD_ENV];
    } else {
      process.env[DEMO_HOLD_ENV] = previousHold;
    }
  });

  it("concurrent redemptions by one user redeem the coupon once", async () => {
    const userId = await seedUser(db.pool, "race@example.test");
    const couponId = await seedCoupon(db.pool, "RACE-ORDER");

    // Hold every request at the check/insert boundary so the interleaving is
    // the same on every run instead of depending on scheduler luck.
    process.env[DEMO_HOLD_ENV] = "200";

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        app.inject({
          method: "POST",
          url: "/coupons/RACE-ORDER/redemptions",
          payload: { userId },
        }),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    const accepted = statuses.filter((status) => status === 201).length;
    const stored = await countRedemptions(db.pool, userId, couponId);

    expect(
      { accepted, stored },
      `Expected one accepted redemption, observed ${accepted} accepted response(s) ` +
        `and ${stored} stored redemption(s). Request statuses: ${statuses.join(", ")}.`,
    ).toEqual({ accepted: 1, stored: 1 });
  });
});

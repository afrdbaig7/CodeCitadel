import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.ts";

import {
  countRedemptions,
  createDisposableDatabase,
  seedCoupon,
  seedUser,
  type DisposableDatabase,
} from "./helpers/database.ts";

/**
 * The behavior the demo expects in ordinary, one-request-at-a-time use.
 *
 * These tests pass on the vulnerable code as well: a repeat redemption that
 * arrives after the first one committed is rejected by the application check.
 * They exist so the fixture has an honest baseline, and so the concurrent check
 * has something to be distinguished from.
 */
describe("coupon redemption", () => {
  let db: DisposableDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createDisposableDatabase();
    app = buildServer(db.pool);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it("a user redeems a coupon once", async () => {
    const userId = await seedUser(db.pool, "first@example.test");
    await seedCoupon(db.pool, "FIRST-ORDER");

    const response = await app.inject({
      method: "POST",
      url: "/coupons/FIRST-ORDER/redemptions",
      payload: { userId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ redemptionId: expect.any(String) });
  });

  it("a repeated redemption is rejected", async () => {
    const userId = await seedUser(db.pool, "repeat@example.test");
    const couponId = await seedCoupon(db.pool, "REPEAT-ORDER");

    const first = await app.inject({
      method: "POST",
      url: "/coupons/REPEAT-ORDER/redemptions",
      payload: { userId },
    });
    const second = await app.inject({
      method: "POST",
      url: "/coupons/REPEAT-ORDER/redemptions",
      payload: { userId },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(await countRedemptions(db.pool, userId, couponId)).toBe(1);
  });

  it("rejects an unknown coupon and a request without a user", async () => {
    const userId = await seedUser(db.pool, "unknown@example.test");

    const unknown = await app.inject({
      method: "POST",
      url: "/coupons/NEVER-ISSUED/redemptions",
      payload: { userId },
    });
    const missingUser = await app.inject({
      method: "POST",
      url: "/coupons/NEVER-ISSUED/redemptions",
      payload: {},
    });

    expect(unknown.statusCode).toBe(404);
    expect(missingUser.statusCode).toBe(400);
  });
});

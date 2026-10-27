import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { redeemCoupon } from "./coupons.ts";

interface RedeemBody {
  userId?: unknown;
}

/**
 * The demo's HTTP surface. It is intentionally thin: the interesting behavior is
 * in `redeemCoupon`, and the tests drive this app through `inject` (in-process
 * requests) or a real socket, so the bug is demonstrated at the request boundary
 * rather than by calling the service directly.
 */
export function buildServer(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.post("/coupons/:code/redemptions", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? null) as RedeemBody | null;
    if (body === null || typeof body.userId !== "string" || body.userId === "") {
      return reply.status(400).send({ error: "userId is required." });
    }

    const outcome = await redeemCoupon(pool, { code, userId: body.userId });
    switch (outcome.status) {
      case "redeemed":
        return reply.status(201).send({ redemptionId: outcome.redemptionId });
      case "already_redeemed":
        return reply
          .status(409)
          .send({ error: "This coupon was already redeemed by this user." });
      case "unknown_coupon":
        return reply.status(404).send({ error: "Unknown coupon." });
    }
  });

  return app;
}

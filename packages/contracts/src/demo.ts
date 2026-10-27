import { z } from "zod";

import { patchVerificationVerdictSchema } from "./patch.js";
import { reproductionVerdictSchema } from "./reproduction.js";

/**
 * The demo report schema version.
 *
 * A demo report is stored evidence of a demonstration: it says which acts were
 * performed now and which were taken from evidence that already existed, so a
 * reader must reject a version it does not understand rather than guess.
 */
export const DEMO_REPORT_SCHEMA_VERSION = 1;

/**
 * How an act came to be part of the report.
 *
 * - `performed` — executed by this command, right now.
 * - `recorded` — established earlier and reused (an acceptance already on
 *   file, a container the operator asked to keep).
 * - `skipped` — deliberately not done, with the reason in `detail`.
 * - `failed` — attempted and unsuccessful.
 */
export const demoActStatusSchema = z.enum(["performed", "recorded", "skipped", "failed"]);
export type DemoActStatus = z.infer<typeof demoActStatusSchema>;

export const demoActSchema = z.object({
  id: z.string().min(1),
  status: demoActStatusSchema,
  detail: z.string().min(1),
});
export type DemoAct = z.infer<typeof demoActSchema>;

/**
 * Where the demo's database is. Credentials are never part of this record: the
 * report names the host, port, database, and container, and nothing more.
 */
export const demoDatabaseSchema = z.object({
  mode: z.enum(["container", "external"]),
  container: z.string().min(1).nullable(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  serverVersion: z.string().min(1).nullable(),
});
export type DemoDatabase = z.infer<typeof demoDatabaseSchema>;

export const demoOutcomeSchema = z.enum(["demonstrated", "not_demonstrated", "inconclusive"]);
export type DemoOutcome = z.infer<typeof demoOutcomeSchema>;

/**
 * One end-to-end demonstration.
 *
 * `acts` is ordered: a reader can see the order the acts happened in, including
 * a failed one and everything that was skipped because of it.
 */
export const demoReportSchema = z.object({
  schemaVersion: z.literal(DEMO_REPORT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  demo: z.literal("coupon-race"),
  project: z.string().min(1),
  /** The disposable copy of the project the demo ran in; the checkout is never used. */
  workCopy: z.string().min(1),
  database: demoDatabaseSchema,
  acts: z.array(demoActSchema).min(1),
  requirement: z.object({
    id: z.string().min(1),
    status: demoActStatusSchema,
    digest: z.string().nullable(),
  }),
  reproduction: z
    .object({
      id: z.string().min(1),
      verdict: reproductionVerdictSchema,
      report: z.string().min(1),
    })
    .nullable(),
  patch: z
    .object({
      verdict: patchVerificationVerdictSchema,
      digest: z.string().min(1),
      report: z.string().min(1),
    })
    .nullable(),
  outcome: demoOutcomeSchema,
  limitations: z.array(z.string().min(1)).min(1),
}).refine((report) => report.outcome !== "demonstrated" || (report.reproduction?.verdict === "reproduced" && report.patch?.verdict === "verified"), {
  message: "a demonstrated outcome needs a reproduced reproduction and a verified patch in the same report",
  path: ["outcome"],
});
export type DemoReport = z.infer<typeof demoReportSchema>;

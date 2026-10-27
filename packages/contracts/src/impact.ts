import { z } from "zod";

/**
 * Impact report schema version. Like the report and diff schemas, this is
 * stored evidence: a reader must reject a version it does not understand.
 */
export const IMPACT_SCHEMA_VERSION = 1;

/** One file whose status changed between the base snapshot and the head scan. */
export const changedFileSchema = z.object({
  path: z.string().min(1),
  change: z.enum(["added", "modified", "removed", "unverified"]),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/** A local import that module resolution could not turn into a file. */
export const unresolvedImportSchema = z.object({
  from: z.string().min(1),
  specifier: z.string().min(1),
});
export type UnresolvedImport = z.infer<typeof unresolvedImportSchema>;

/**
 * One hop in the explanation for a selected test. `relation` says whether the
 * step is "this file imports the next one" or "this file is the changed one",
 * so a chain can be read as a sentence rather than a list.
 */
export const impactChainEntrySchema = z.object({
  path: z.string().min(1),
  relation: z.enum(["changed", "imports"]),
});
export type ImpactChainEntry = z.infer<typeof impactChainEntrySchema>;

export const impactedFileSchema = z.object({
  path: z.string().min(1),
  /** 0 means the file itself changed; 1 means a direct importer, and so on. */
  depth: z.number().int().nonnegative(),
  chain: z.array(impactChainEntrySchema).min(1),
});
export type ImpactedFile = z.infer<typeof impactedFileSchema>;

export const impactReportSchema = z.object({
  schemaVersion: z.literal(IMPACT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  root: z.string().min(1),
  base: z.object({
    generatedAt: z.iso.datetime(),
    root: z.string().min(1),
  }),
  changed: z.array(changedFileSchema),
  graph: z.object({
    /** Source modules that were parsed, not every scanned file. */
    modules: z.number().int().nonnegative(),
    /** Resolved import edges. */
    edges: z.number().int().nonnegative(),
    testFiles: z.number().int().nonnegative(),
    /** Bare or absolute specifiers (packages, node builtins); not followed. */
    externalImports: z.number().int().nonnegative(),
    /**
     * Local specifiers that resolved to a file the scan did not cover (ignored,
     * a `.d.ts`, or outside the root). Their contents never influenced this
     * report, so the impact of changing them is unknown.
     */
    outsideScope: z.number().int().nonnegative(),
    unresolved: z.array(unresolvedImportSchema),
  }),
  /** Every file reachable backwards from a change, including non-tests. */
  impacted: z.array(impactedFileSchema),
  tests: z.object({
    selected: z.array(impactedFileSchema),
    /** Test files in the graph that are not reachable from any change. */
    notSelected: z.number().int().nonnegative(),
  }),
  /**
   * False when at least one changed file could not be placed in the graph or a
   * local import could not be resolved. A false value means the test list is a
   * lower bound, never a complete answer.
   */
  complete: z.boolean(),
  incompleteReasons: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)).min(1),
});
export type ImpactReport = z.infer<typeof impactReportSchema>;

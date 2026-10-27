import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "@codecitadel/contracts";

export const MANIFEST_FILE_NAME = "control-manifest.json";

export const TASK_STATUS = ["pending", "in_progress", "blocked", "done", "rejected"] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const RESOURCE_STATUS = ["ready", "locked", "released", "exhausted"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUS)[number];

export const RESOURCE_KIND = ["postgres", "temporal", "object-storage", "queue", "sandbox", "other"] as const;
export type ResourceKind = (typeof RESOURCE_KIND)[number];

export const ACTION_KIND = ["create", "adopted", "migrated", "rechecked", "released"] as const;
export type ActionKind = (typeof ACTION_KIND)[number];

export interface TaskEntry {
  id: string;
  scope: string;
  summary: string;
  status: TaskStatus;
  attempt: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
  requires?: string[];
}

export interface ResourceEntry {
  id: string;
  kind: ResourceKind;
  claim: string | null;
  status: ResourceStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface StoreEntry {
  entry: "task" | "resource";
  task?: TaskEntry;
  resource?: ResourceEntry;
  reason?: string;
}

export interface ManifestEntry {
  entry: StoreEntry;
  sequence: number;
  appliedBy: string;
  appliedAt: string;
}

export interface Manifest {
  schemaVersion: number;
  version: number;
  sourceRoot: string;
  appliedBy: string;
  createdAt: string;
  entries: ManifestEntry[];
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative(),
  sourceRoot: z.string().min(1),
  appliedBy: z.string().min(1),
  createdAt: z.string().datetime(),
  entries: z.array(z.object({
    entry: z.union([z.literal("task"), z.literal("resource")]),
    task: z.object({
      id: z.string().min(1),
      scope: z.string().min(1),
      summary: z.string().min(1),
      status: z.enum(TASK_STATUS),
      attempt: z.number().int().nonnegative(),
      createdBy: z.string().min(1),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      note: z.string().optional(),
      requires: z.array(z.string()).optional(),
    }).optional(),
    resource: z.object({
      id: z.string().min(1),
      kind: z.enum(RESOURCE_KIND),
      claim: z.string().nullable(),
      status: z.enum(RESOURCE_STATUS),
      createdBy: z.string().min(1),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      note: z.string().optional(),
    }).optional(),
    reason: z.string().optional(),
    sequence: z.number().int().nonnegative(),
    appliedBy: z.string().min(1),
    appliedAt: z.string().datetime(),
  })),
});

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function parseManifest(raw: string, source = "control manifest"): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ManifestError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ManifestError(
      `${source} does not match manifest schema version 1${issue ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid document"}`,
    );
  }
  return result.data;
}

export function createEmptyManifest(sourceRoot: string, appliedBy: string): Manifest {
  return {
    schemaVersion: 1,
    version: 0,
    sourceRoot: path.resolve(sourceRoot),
    appliedBy,
    createdAt: new Date().toISOString(),
    entries: [],
  };
}

export function hashManifest(manifest: Manifest): string {
  const raw = JSON.stringify(manifest, null, 2);
  return `sha256:${createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex")}`;
}

export function manifestBytes(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}

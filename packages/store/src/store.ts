import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import type { Manifest, ManifestEntry, TaskEntry, TaskStatus, ResourceEntry, ResourceStatus, ResourceKind } from "./manifest.js";
import { ACTION_KIND, TASK_STATUS, RESOURCE_STATUS, RESOURCE_KIND } from "./manifest.js";

export const STORE_FILE_NAME = "control-plane.sqlite";

/** One manifest write is capped here: an attacker-controlled argument must not exhaust disk. */
export const MANIFEST_WRITE_LIMIT_BYTES = 256 * 1024;

export interface StoreOptions {
  root: string;
  appliedBy: string;
  actor?: string;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

function resolveStoreFile(root: string): string {
  return path.resolve(root, STORE_FILE_NAME);
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdir(dir, { recursive: true }).catch(() => {
    throw new StoreError(`Cannot create ${dir}: it is not a directory`);
  });
}

function normalizeStatus(value: unknown, allowed: readonly string[], context: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new StoreError(`${context} must be one of ${allowed.join(", ")}, received ${JSON.stringify(value)}`);
  }
  return value;
}

export class Store {
  private readonly db: Database.Database;
  private readonly storePath: string;
  private readonly appliedBy: string;
  private readonly actor: string;

  constructor(options: StoreOptions) {
    this.storePath = resolveStoreFile(options.root);
    this.appliedBy = options.appliedBy;
    this.actor = options.actor ?? "local-user";

    ensureDirectory(this.storePath);

    this.db = new Database(this.storePath, { readonly: true, fileMustExist: true });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manifest (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entryKind TEXT NOT NULL,
        entryId TEXT NOT NULL,
        scope TEXT,
        summary TEXT,
        status TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        note TEXT,
        requires TEXT,
        resourceId TEXT,
        resourceKind TEXT,
        resourceClaim TEXT,
        resourceStatus TEXT,
        resourceCreatedBy TEXT,
        resourceCreatedAt TEXT,
        resourceUpdatedAt TEXT,
        resourceNote TEXT,
        actionKind TEXT NOT NULL,
        reason TEXT,
        appliedBy TEXT NOT NULL,
        appliedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_manifest_sequence ON manifest(sequence);
    `);
  }

  private insertEntry(entry: ManifestEntry): void {
    const { task, resource } = entry.entry;

    if (task !== undefined && resource !== undefined) {
      throw new StoreError("A manifest entry may only carry one of task or resource");
    }

    const kind: "task" | "resource" = task !== undefined ? "task" : "resource";
    const record: TaskEntry | ResourceEntry = task ?? resource;
    const fields: string[] = [];
    const values: unknown[] = [];
    const paramNames: string[] = [];

    const push = (field: string, value: unknown) => {
      fields.push(`${field} = ?`);
      values.push(value);
      paramNames.push(`${field}`);
    };

    this.db.transaction(() => {
      push("entryKind", kind);
      push("entryId", record.id);
      if (task !== undefined) {
        push("scope", task.scope);
        push("summary", task.summary);
        push("status", task.status);
        push("attempt", task.attempt);
        push("createdBy", task.createdBy);
        push("createdAt", task.createdAt);
        push("updatedAt", task.updatedAt);
        push("note", task.note ?? null);
        push("requires", JSON.stringify(task.requires ?? []));
      } else {
        push("resourceId", resource.id);
        push("resourceKind", resource.kind);
        push("resourceClaim", resource.claim ?? null);
        push("resourceStatus", resource.status);
        push("resourceCreatedBy", resource.createdBy);
        push("resourceCreatedAt", resource.createdAt);
        push("resourceUpdatedAt", resource.updatedAt);
        push("resourceNote", resource.note ?? null);
      }
      push("actionKind", entry.action);
      push("reason", entry.reason ?? null);
      push("appliedBy", entry.appliedBy);
      push("appliedAt", entry.appliedAt);

      const sql = `
        INSERT INTO manifest (${["entryKind", "entryId", "scope", "summary", "status", "attempt", "createdBy", "createdAt", "updatedAt", "note", "requires", "resourceId", "resourceKind", "resourceClaim", "resourceStatus", "resourceCreatedBy", "resourceCreatedAt", "resourceUpdatedAt", "resourceNote", "actionKind", "reason", "appliedBy", "appliedAt"].join(", ")})
        VALUES (${paramNames.join(", ")})
      `;
      this.db.prepare(sql).run(values);
    })();
  }

  private applyTransaction(operation: (manifest: Manifest) => Manifest): void {
    const current = this.readManifest();
    const next = operation(current);

    if (next.entries.length > current.entries.length + 1) {
      throw new StoreError("A transaction may append at most one entry");
    }
    if (!next.entries.some((entry) => entry.sequence === current.entries.length)) {
      throw new StoreError("Transactions must append contiguous entries");
    }

    const raw = manifestBytes(next);
    if (Buffer.byteLength(raw, "utf8") > MANIFEST_WRITE_LIMIT_BYTES) {
      throw new StoreError(`Manifest exceeds the ${MANIFEST_WRITE_LIMIT_BYTES} byte write limit`);
    }

    this.db.transaction(() => {
      for (const entry of next.entries) {
        this.insertEntry(entry);
      }
    })();
    this.persist(next);
  }

  private persist(manifest: Manifest): void {
    const raw = manifestBytes(manifest);
    fs.writeFile(this.storePath, raw, "utf8").catch((error) => {
      throw new StoreError(`Cannot write ${this.storePath}: ${(error as Error).message}`);
    });
  }

  private readManifestFile(): string {
    try {
      return fs.readFileSync(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private readManifest(): Manifest {
    const raw = this.readManifestFile();
    if (raw === "") {
      return { schemaVersion: 1, version: 0, sourceRoot: this.storePath, appliedBy: this.appliedBy, createdAt: new Date().toISOString(), entries: [] };
    }
    return parseManifest(raw, this.storePath);
  }

  read(): Manifest {
    return this.readManifest();
  }

  taskList(): TaskEntry[] {
    const manifest = this.readManifest();
    return manifest.entries
      .map((entry) => {
        const record = entry.entry.task;
        return record ?? null;
      })
      .filter((entry): entry is TaskEntry => entry !== null);
  }

  taskById(id: string): TaskEntry | null {
    return this.taskList().find((entry) => entry.id === id) ?? null;
  }

  async upsertTask(input: {
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
  }): Promise<Manifest> {
    const now = new Date().toISOString();
    const { id, scope, summary, status, attempt, createdBy, createdAt, updatedAt, note, requires } = input;
    const entry: TaskEntry = {
      id,
      scope: scope.trim(),
      summary: summary.trim(),
      status,
      attempt: Math.max(0, attempt),
      createdBy,
      createdAt,
      updatedAt,
      note,
      requires: requires?.filter((item) => item.trim().length > 0) ?? [],
    };

    this.applyTransaction((current) => {
      const entries = [...current.entries];
      const index = entries.findIndex((item) => item.entry === "task" && item.entry.task?.id === id);
      if (index === -1) {
        entries.push({
          entry: {
            task: entry,
          },
        });
      }

      return entries;
    });
    return current;
  }

  async upsertResource(input: {
    id: string;
    kind: ResourceKind;
    claim: string | null;
    status: ResourceStatus;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    note?: string;
  }): Promise<Manifest> {
    const { id, kind, claim, status, createdBy, createdAt, updatedAt, note } = input;
    const entry: ResourceEntry = {
      id,
      kind,
      claim,
      status,
      createdBy,
      createdAt,
      updatedAt,
      note,
    };

    this.applyTransaction((current) => {
      const entries = [...current.entries];
      const index = entries.findIndex((item) => item.entry === "resource" && item.entry.resource?.id === id);
      if (index === -1) {
        entries.push({
          entry: {
            resource: entry,
          },
        });
      }

      return entries;
    });
    return current;
  }

  resourceById(id: string): ResourceEntry | null {
    return this.taskList().find((entry) => entry.id === id) ?? null;
  }

  dispose(): void {
    // no-op; the file is a versioned manifest, not a live database handle
  }
}

import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { MANIFEST_FILE_NAME, STORE_FILE_NAME } from "./manifest.js";
import { openStore, StoreError } from "./store.js";

export interface MigrationOptions extends StoreOptions {
  /** Directory the migration is allowed to write into. Defaults to the checkout root. */
  migrationsDir?: string;
}

export interface MigrationResult {
  storePath: string;
  manifestPath: string;
  sourceRoot: string;
  appliedBy: string;
  actor: string;
}

/**
 * The first control-plane migration.
 *
 * It creates `control-plane.sqlite` and `control-manifest.json` in one
 * transactional write, then records the migration as the first manifest entry.
 * Because the manifest is append-only, the same migration run twice stays the
 * same version and the same entry.
 */
export async function migrate(options: MigrationOptions): Promise<MigrationResult> {
  const root = path.resolve(options.root);
  const migrationsDir = path.resolve(options.migrationsDir ?? root);
  const storePath = path.resolve(root, STORE_FILE_NAME);
  const manifestPath = path.resolve(root, MANIFEST_FILE_NAME);

  const appliedBy = options.appliedBy.trim() || "codebuff";
  const actor = options.actor ?? "codebuff";

  const existed = await fs
    .access(storePath)
    .then(() => true)
    .catch(() => false);

  if (existed) {
    const store = openStore({ root, appliedBy, actor });
    const manifest = store.read();
    store.dispose();
    return {
      storePath,
      manifestPath,
      sourceRoot: manifest.sourceRoot,
      appliedBy,
      actor,
    };
  }

  ensureMigrationDirectory(migrationsDir);
  await fs.mkdir(storePath, { recursive: true }).catch(() => {
    throw new Error(`Cannot create store directory ${storePath}`);
  });

  const db = new Database(storePath, { readonly: false, fileMustExist: false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE manifest (
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
    CREATE INDEX idx_manifest_sequence ON manifest(sequence);
  `);
  db.exec("PRAGMA user_version = 1;");
  db.close();

  const manifest = {
    schemaVersion: 1,
    version: 1,
    sourceRoot: root,
    appliedBy,
    createdAt: new Date().toISOString(),
    entries: [
      {
        entry: { entry: "resource", resource: {
          id: "resource:r2-local-control-plane",
          kind: "other",
          claim: null,
          status: "ready",
          createdBy: actor,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          note: "R2 control plane guard; no Terraform, no hosted Postgres, no Temporal in this checkout.",
        } },
        sequence: 0,
        appliedBy,
        appliedAt: new Date().toISOString(),
      },
    ],
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.writeFile(storePath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    storePath,
    manifestPath,
    sourceRoot: root,
    appliedBy,
    actor,
  };
}

function ensureMigrationDirectory(directory: string): void {
  fs.mkdir(directory, { recursive: true }).catch(() => {
    throw new StoreError(`Cannot create ${directory}`);
  });
}

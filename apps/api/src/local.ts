import { randomBytes } from "node:crypto";
import path from "node:path";

import { API_SCHEMA_VERSION } from "@codecitadel/contracts";
import {
  PostgresReportStore,
  ReportStore,
  type EvidenceStore,
  type Organization,
} from "@codecitadel/storage";

import { buildServer } from "./server.js";

export interface LocalServerOptions {
  port?: number;
  host?: string;
  /** Directory for SQLite or for artifacts when PostgreSQL is selected. */
  dataDir?: string;
  /** Select PostgreSQL instead of the local SQLite default. Never printed in logs. */
  databaseUrl?: string;
  maxDatabaseConnections?: number;
  organizationSlug?: string;
  /** Use this bearer token instead of generating one. */
  token?: string;
  /** Built dashboard directory to serve; null serves the API only. */
  dashboardDir?: string | null;
}

export interface LocalServer {
  schemaVersion: number;
  url: string;
  host: string;
  port: number;
  token: string;
  organization: Organization;
  /** SQLite file, or a display-safe label when PostgreSQL is selected. */
  dataFile: string;
  dashboardServed: boolean;
  /** Closes the listener and the database. Safe to call once. */
  close(): Promise<void>;
}

/**
 * Starts the local control plane on loopback.
 *
 * The same function backs the `codecitadel-server` binary and `codecitadel
 * serve`, so there is one place that decides where the database lives, which
 * token the browser and the CLI share, and whether the dashboard is served.
 * It never executes repository code.
 */
export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const dataDir = path.resolve(options.dataDir ?? path.join(".codecitadel", "server"));
  const dataFile =
    options.databaseUrl === undefined ? path.join(dataDir, "evidence.db") : "PostgreSQL";
  const store: EvidenceStore =
    options.databaseUrl === undefined
      ? new ReportStore({ file: dataFile, artifactsDir: path.join(dataDir, "artifacts") })
      : await PostgresReportStore.open({
          connectionString: options.databaseUrl,
          artifactsDir: path.join(dataDir, "artifacts"),
          ...(options.maxDatabaseConnections === undefined
            ? {}
            : { maxConnections: options.maxDatabaseConnections }),
        });

  let organization: Organization;
  let token: string;
  try {
    organization = await store.ensureOrganization(options.organizationSlug ?? "local");
    token = options.token ?? `cc_${randomBytes(24).toString("hex")}`;
    await store.issueToken({ organizationId: organization.id, token, label: "local operator" });
  } catch (error) {
    await store.close();
    throw error;
  }

  const app = buildServer({
    store,
    ...(options.dashboardDir === undefined || options.dashboardDir === null
      ? {}
      : { dashboard: { dir: options.dashboardDir, sessionToken: token } }),
  });

  try {
    await app.listen({ port, host });
  } catch (error) {
    await store.close();
    throw error;
  }

  return {
    schemaVersion: API_SCHEMA_VERSION,
    url: `http://${host}:${port}`,
    host,
    port,
    token,
    organization,
    dataFile:
      options.databaseUrl === undefined
        ? dataFile
        : `${dataFile} (artifacts: ${path.join(dataDir, "artifacts")})`,
    dashboardServed: options.dashboardDir !== undefined && options.dashboardDir !== null,
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
    },
  };
}

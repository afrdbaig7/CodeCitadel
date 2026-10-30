import { randomBytes } from "node:crypto";
import path from "node:path";

import { API_SCHEMA_VERSION } from "@codecitadel/contracts";
import {
  PostgresReportStore,
  ReportStore,
  S3ArtifactStorage,
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
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUrl?: string;
  bootstrapAdminIssuer?: string;
  bootstrapAdminSubject?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
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

/** Starts the local control plane on loopback; this server never executes repository code. */
export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const dataDir = path.resolve(options.dataDir ?? path.join(".codecitadel", "server"));
  const dataFile = options.databaseUrl === undefined ? path.join(dataDir, "evidence.db") : "PostgreSQL";
  const hasOidc = options.oidcIssuer !== undefined || options.oidcAudience !== undefined || options.oidcJwksUrl !== undefined;
  if (hasOidc && (options.oidcIssuer === undefined || options.oidcAudience === undefined)) {
    throw new Error("OIDC issuer and audience must be configured together.");
  }
  if (options.s3Bucket !== undefined && options.databaseUrl === undefined) {
    throw new Error("S3 artifact storage is available only with PostgreSQL-backed hosted mode.");
  }
  if (hasOidc && (options.bootstrapAdminIssuer === undefined || options.bootstrapAdminSubject === undefined)) {
    throw new Error("OIDC requires a configured bootstrap administrator issuer and subject.");
  }

  const store: EvidenceStore = options.databaseUrl === undefined
    ? new ReportStore({ file: dataFile, artifactsDir: path.join(dataDir, "artifacts") })
    : await PostgresReportStore.open({
        connectionString: options.databaseUrl,
        artifactsDir: path.join(dataDir, "artifacts"),
        ...(options.maxDatabaseConnections === undefined ? {} : { maxConnections: options.maxDatabaseConnections }),
      });

  let objectStorage: S3ArtifactStorage | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  try {
    const organization = await store.ensureOrganization(options.organizationSlug ?? "local");
    const token = options.token ?? `cc_${randomBytes(24).toString("hex")}`;
    if (!hasOidc) {
      await store.issueToken({ organizationId: organization.id, token, label: "local operator", role: "admin" });
    } else {
      const issuer = options.bootstrapAdminIssuer!;
      const subject = options.bootstrapAdminSubject!;
      const memberships = await store.findMembership(issuer, subject);
      if (!memberships.some((member) => member.id === organization.id && member.role === "admin")) {
        await store.setMembership({ organizationId: organization.id, issuer, subject, role: "admin" });
      }
    }

    if (options.s3Bucket !== undefined) {
      objectStorage = new S3ArtifactStorage({
        bucket: options.s3Bucket,
        region: options.s3Region ?? "us-east-1",
        ...(options.s3Endpoint === undefined ? {} : { endpoint: options.s3Endpoint }),
        ...(options.s3ForcePathStyle === undefined ? {} : { forcePathStyle: options.s3ForcePathStyle }),
      });
    }
    const oidc = !hasOidc ? undefined : {
      issuer: options.oidcIssuer!,
      audience: options.oidcAudience!,
      ...(options.oidcJwksUrl === undefined ? {} : { jwksUrl: options.oidcJwksUrl }),
    };
    const bootstrapAdmin = !hasOidc ? undefined : {
      issuer: options.bootstrapAdminIssuer!,
      subject: options.bootstrapAdminSubject!,
    };
    app = buildServer({
      store,
      ...(oidc === undefined || bootstrapAdmin === undefined ? {} : { oidc, bootstrapAdmin }),
      ...(objectStorage === undefined ? {} : { objectStorage }),
      ...(options.dashboardDir === undefined || options.dashboardDir === null
        ? {}
        : { dashboard: { dir: options.dashboardDir, sessionToken: token } }),
    });
    await app.listen({ port, host });
    return {
      schemaVersion: API_SCHEMA_VERSION,
      url: `http://${host}:${port}`,
      host,
      port,
      token,
      organization,
      dataFile: options.databaseUrl === undefined
        ? dataFile
        : `${dataFile} (artifacts: ${path.join(dataDir, "artifacts")})`,
      dashboardServed: options.dashboardDir !== undefined && options.dashboardDir !== null,
      close: async (): Promise<void> => {
        await app!.close();
        objectStorage?.close();
        await store.close();
      },
    };
  } catch (error) {
    objectStorage?.close();
    if (app !== undefined) await app.close().catch(() => undefined);
    await store.close();
    throw error;
  }
}

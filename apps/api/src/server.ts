import {
  API_SCHEMA_VERSION,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  MAX_UPLOAD_BYTES,
  apiErrorSchema,
  healthResponseSchema,
  outcomeOf,
  payloadDigest,
  reportSchemaFor,
  reportUploadSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  uploadResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@codecitadel/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EvidenceStore, Organization } from "@codecitadel/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * The built dashboard, served from the same loopback listener as the API.
 *
 * Serving it from the same origin is what lets the browser authenticate with a
 * same-site cookie instead of a bearer token placed in a URL, and what keeps
 * cross-origin requests unnecessary.
 */
export interface DashboardOptions {
  /** Absolute path to a built dashboard directory (the Vite `dist` output). */
  dir: string;
  /** Ephemeral local token, set as an HttpOnly cookie when the page is served. */
  sessionToken: string;
}

export interface ServerOptions {
  store: EvidenceStore;
  /** Defaults to a quiet logger: a CLI user does not want request logs on stdout. */
  logger?: boolean;
  dashboard?: DashboardOptions;
}

const SESSION_COOKIE = "codecitadel_session";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Headers that describe what the stored evidence is, not what it means. */
const EVIDENCE_LIMITATIONS = [
  "Uploaded reports are user-controlled evidence. The server validates their shape and tenant, not that the tests they describe actually ran.",
  "Origin is taken from the uploader and restricted to local or user-ci; this deployment never claims managed execution.",
  "Artifacts are stored on the local filesystem, not in object storage, and are not encrypted at rest.",
  "The dashboard is prebuilt static files served by this loopback listener. It reads stored reports; it never executes repository code and holds no authority of its own.",
  "There is no object storage and no OIDC identity provider in this milestone; the API authenticates bearer tokens issued by the operator, plus a same-site cookie for the local dashboard.",
];

function errorBody(code: ApiErrorCode, message: string) {
  return apiErrorSchema.parse({ schemaVersion: API_SCHEMA_VERSION, error: { code, message } });
}

function fail(reply: FastifyReply, status: number, code: ApiErrorCode, message: string) {
  return reply.status(status).send(errorBody(code, message));
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/** Reads one cookie by name from the request. No cookie jar, no parsing library. */
function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * A caller is either an API client (bearer header) or the locally served
 * dashboard (HttpOnly same-site cookie). Both go through the same store lookup,
 * so a token the store does not know is refused either way.
 */
function requestToken(request: FastifyRequest): string | null {
  return bearerToken(request) ?? cookieValue(request, SESSION_COOKIE);
}

/**
 * The tenant always comes from the token. A body field cannot select an
 * organization, which is why the upload schema has no such field at all.
 */
async function authenticate(
  store: EvidenceStore,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Organization | null> {
  const token = requestToken(request);
  if (token === null) {
    fail(reply, 401, "unauthorized", "Send an Authorization: Bearer <token> header.");
    return null;
  }
  const organization = await store.authenticate(token);
  if (organization === null) {
    fail(reply, 401, "unauthorized", "The bearer token is not recognized.");
    return null;
  }
  return organization;
}

async function sendDashboardFile(
  reply: FastifyReply,
  file: string,
  cacheControl: string,
): Promise<FastifyReply> {
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) {
    return fail(
      reply,
      404,
      "not_found",
      "The dashboard has no built asset at that path. Rebuild it with `pnpm --filter @codecitadel/dashboard build`.",
    );
  }
  return reply
    .header("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream")
    .header("cache-control", cacheControl)
    .send(bytes);
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_UPLOAD_BYTES,
  });

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, _request, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return fail(
        reply,
        413,
        "too_large",
        `The body is larger than ${MAX_UPLOAD_BYTES} bytes. Split the artifacts out of the upload.`,
      );
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      return fail(reply, 500, "invalid_request", "The server could not process this request.");
    }
    return fail(reply, status, "invalid_request", error.message);
  });

  app.setNotFoundHandler((_request, reply) =>
    fail(reply, 404, "not_found", "No route matches this path."),
  );

  app.get("/api/v1/health", async (): Promise<HealthResponse> =>
    healthResponseSchema.parse({
      schemaVersion: API_SCHEMA_VERSION,
      status: "ok",
      storage: { driver: store.driver, schemaVersion: store.schemaVersion },
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxArtifacts: MAX_ARTIFACTS,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
      },
      limitations: EVIDENCE_LIMITATIONS,
    }),
  );

  if (options.dashboard !== undefined) {
    const { dir, sessionToken } = options.dashboard;
    const root = path.resolve(dir);
    const assets = path.join(root, "assets");

    const serveIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const html = await readFile(path.join(root, "index.html")).catch(() => null);
      if (html === null) {
        return fail(
          reply,
          404,
          "not_found",
          "The dashboard has not been built. Run `pnpm --filter @codecitadel/dashboard build` and restart, or start with --no-dashboard.",
        );
      }
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .header(
          "set-cookie",
          `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        )
        .send(html);
    };

    app.get("/", serveIndex);
    app.get("/index.html", serveIndex);

    app.get("/assets/*", async (request, reply) => {
      const relative = (request.params as { "*": string })["*"];
      const target = path.resolve(assets, relative);
      if (!target.startsWith(assets + path.sep)) {
        return fail(reply, 404, "not_found", "No route matches this path.");
      }
      // Vite fingerprints these names, so they can be cached for a year.
      return sendDashboardFile(reply, target, "public, max-age=31536000, immutable");
    });
  }

  app.post("/api/v1/reports", async (request, reply) => {
    const organization = await authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }

    const envelope = reportUploadSchema.safeParse(request.body);
    if (!envelope.success) {
      const issue = envelope.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      return fail(
        reply,
        400,
        "invalid_request",
        `The upload does not match the API schema${where}: ${issue?.message ?? "invalid body"}.`,
      );
    }

    const upload = envelope.data;
    const reportSchema = reportSchemaFor(upload.kind);
    const report = reportSchema.safeParse(upload.report);
    if (!report.success) {
      const issue = report.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      return fail(
        reply,
        400,
        "unsupported_kind",
        `The report does not match the ${upload.kind} contract${where}: ${issue?.message ?? "invalid report"}.`,
      );
    }

    const artifacts: { name: string; digest: string; bytes: Buffer }[] = [];
    for (const artifact of upload.artifacts) {
      const bytes = Buffer.from(artifact.contentBase64, "base64");
      if (bytes.length === 0) {
        return fail(reply, 400, "invalid_request", `Artifact ${artifact.name} is empty.`);
      }
      if (bytes.length > MAX_ARTIFACT_BYTES) {
        return fail(
          reply,
          413,
          "too_large",
          `Artifact ${artifact.name} is ${bytes.length} bytes, more than the limit of ${MAX_ARTIFACT_BYTES}.`,
        );
      }
      const digest = payloadDigest(bytes);
      if (digest !== artifact.digest) {
        return fail(
          reply,
          400,
          "invalid_request",
          `Artifact ${artifact.name} does not match its digest: declared ${artifact.digest.slice(0, 21)}…, computed ${digest.slice(0, 21)}….`,
        );
      }
      artifacts.push({ name: artifact.name, digest, bytes });
    }

    const reportJson = JSON.stringify(upload.report);
    const run = await store.insertRun({
      organizationId: organization.id,
      repository: upload.repository,
      kind: upload.kind,
      origin: upload.origin,
      capturedAt: upload.capturedAt,
      receivedAt: new Date().toISOString(),
      reportJson,
      outcome: outcomeOf(upload.kind, upload.report),
      artifacts,
    });

    return reply
      .status(202)
      .send(uploadResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, run }));
  });

  app.get("/api/v1/runs", async (request, reply) => {
    const organization = await authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const query = request.query as { limit?: string };
    const limit = query.limit === undefined ? 50 : Number.parseInt(query.limit, 10);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      return fail(reply, 400, "invalid_request", "--limit must be between 1 and 200.");
    }
    const runs = await store.listRuns(organization.id, limit);
    return runListResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, runs });
  });

  app.get("/api/v1/runs/:id", async (request, reply) => {
    const organization = await authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const { id } = request.params as { id: string };
    const detail = await store.getRun(organization.id, id);
    if (detail === null) {
      return fail(reply, 404, "not_found", `There is no run ${id} in this organization.`);
    }
    return runDetailResponseSchema.parse({
      schemaVersion: API_SCHEMA_VERSION,
      run: detail.run,
      report: JSON.parse(detail.reportJson) as unknown,
    });
  });

  app.get("/api/v1/runs/:id/artifacts/:name", async (request, reply) => {
    const organization = await authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const { id, name } = request.params as { id: string; name: string };
    const artifact = await store.readArtifact(organization.id, id, name);
    if (artifact === null) {
      return fail(reply, 404, "not_found", `There is no artifact ${name} for run ${id} in this organization.`);
    }
    return reply
      .header("content-type", "application/octet-stream")
      .header("x-codecitadel-digest", artifact.digest)
      .send(artifact.bytes);
  });

  return app;
}

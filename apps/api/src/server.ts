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
import type { Organization, ReportStore } from "@codecitadel/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export interface ServerOptions {
  store: ReportStore;
  /** Defaults to a quiet logger: a CLI user does not want request logs on stdout. */
  logger?: boolean;
}

/** Headers that describe what the stored evidence is, not what it means. */
const EVIDENCE_LIMITATIONS = [
  "Uploaded reports are user-controlled evidence. The server validates their shape and tenant, not that the tests they describe actually ran.",
  "Origin is taken from the uploader and restricted to local or user-ci; this deployment never claims managed execution.",
  "Artifacts are stored on the local filesystem, not in object storage, and are not encrypted at rest.",
  "There is no dashboard, no object storage, and no OIDC identity provider in this milestone; the API authenticates bearer tokens issued by the operator.",
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

/**
 * The tenant always comes from the token. A body field cannot select an
 * organization, which is why the upload schema has no such field at all.
 */
function authenticate(
  store: ReportStore,
  request: FastifyRequest,
  reply: FastifyReply,
): Organization | null {
  const token = bearerToken(request);
  if (token === null) {
    fail(reply, 401, "unauthorized", "Send an Authorization: Bearer <token> header.");
    return null;
  }
  const organization = store.authenticate(token);
  if (organization === null) {
    fail(reply, 401, "unauthorized", "The bearer token is not recognized.");
    return null;
  }
  return organization;
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
      storage: { driver: "sqlite", schemaVersion: store.schemaVersion },
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxArtifacts: MAX_ARTIFACTS,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
      },
      limitations: EVIDENCE_LIMITATIONS,
    }),
  );

  app.post("/api/v1/reports", async (request, reply) => {
    const organization = authenticate(store, request, reply);
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
    const run = store.insertRun({
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
    const organization = authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const query = request.query as { limit?: string };
    const limit = query.limit === undefined ? 50 : Number.parseInt(query.limit, 10);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      return fail(reply, 400, "invalid_request", "--limit must be between 1 and 200.");
    }
    const runs = store.listRuns(organization.id, limit);
    return runListResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, runs });
  });

  app.get("/api/v1/runs/:id", async (request, reply) => {
    const organization = authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const { id } = request.params as { id: string };
    const detail = store.getRun(organization.id, id);
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
    const organization = authenticate(store, request, reply);
    if (organization === null) {
      return reply;
    }
    const { id, name } = request.params as { id: string; name: string };
    const artifact = store.readArtifact(organization.id, id, name);
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

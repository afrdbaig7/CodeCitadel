import {
  API_SCHEMA_VERSION, INLINE_ARTIFACT_BYTES, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES, MAX_REPORT_BYTES, MAX_UPLOAD_BYTES,
  apiErrorSchema, healthResponseSchema, outcomeOf, payloadDigest, reportSchemaFor, reportUploadSchema,
  runDetailResponseSchema, runListResponseSchema, uploadResponseSchema, type ApiErrorCode, type HealthResponse,
} from "@codecitadel/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { S3ArtifactStorage, type AuthPrincipal, type EvidenceStore } from "@codecitadel/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { OidcVerifier, type OidcOptions } from "./oidc.js";

export interface DashboardOptions { dir: string; sessionToken: string; }
export interface ServerOptions {
  store: EvidenceStore;
  logger?: boolean;
  dashboard?: DashboardOptions;
  oidc?: OidcOptions;
  bootstrapAdmin?: { issuer: string; subject: string };
  objectStorage?: S3ArtifactStorage;
}

const SESSION_COOKIE = "codecitadel_session";
const CONTENT_TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const BASE_LIMITATIONS = [
  "Uploaded reports are user-controlled evidence. The server validates their shape and tenant, not that the tests they describe actually ran.",
  "Origin is taken from the uploader and restricted to local or user-ci; this deployment never claims managed execution.",
  "The dashboard is prebuilt static files. It reads stored reports and never executes repository code.",
];
function errorBody(code: ApiErrorCode, message: string) { return apiErrorSchema.parse({ schemaVersion: API_SCHEMA_VERSION, error: { code, message } }); }
function fail(reply: FastifyReply, status: number, code: ApiErrorCode, message: string) { return reply.status(status).send(errorBody(code, message)); }
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && header.slice(7).trim() !== "" ? header.slice(7).trim() : null;
}
function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) { const at = part.indexOf("="); if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null; }
  return null;
}
function requestActor(request: FastifyRequest, principal: AuthPrincipal): string {
  return (request as FastifyRequest & { actor?: string }).actor ?? principal.subject ?? `token:${principal.id}`;
}
function parseToken(request: FastifyRequest): string | null {
  const authorization = bearerToken(request);
  if (authorization !== null) return authorization;
  return cookieValue(request, SESSION_COOKIE);
}
async function authenticate(options: ServerOptions, verifier: OidcVerifier | undefined, request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
  const token = parseToken(request);
  if (token === null) { fail(reply, 401, "unauthorized", "Send an Authorization: Bearer <token> header."); return null; }
  if (verifier !== undefined && token.split(".").length === 3) {
    try {
      const identity = await verifier.verify(token);
      const memberships = await options.store.findMembership(identity.issuer, identity.subject);
      const requested = request.headers["x-codecitadel-organization"];
      const isBootstrapAdmin = options.bootstrapAdmin?.issuer === identity.issuer && options.bootstrapAdmin.subject === identity.subject;
      const principal = typeof requested === "string"
        ? memberships.find((member) => member.slug === requested || member.id === requested)
        : memberships.length === 1 ? memberships[0] : undefined;
      if (isBootstrapAdmin && principal === undefined && requested === undefined) {
        fail(reply, 400, "invalid_request", "The bootstrap administrator must select an organization."); return null;
      }
      if (isBootstrapAdmin && principal === undefined && typeof requested === "string") {
        const organization = await options.store.getOrganization(requested);
        if (organization !== null) {
          (request as FastifyRequest & { actor?: string }).actor = `${identity.issuer}|${identity.subject}`;
          return { ...organization, role: "admin", issuer: identity.issuer, subject: identity.subject };
        }
      }
      if (memberships.length === 0 && !isBootstrapAdmin) { fail(reply, 403, "unauthorized", "The verified identity has no organization membership."); return null; }
      if (principal === undefined) { fail(reply, 403, "unauthorized", "The identity is not a member of the selected organization."); return null; }
      (request as FastifyRequest & { actor?: string }).actor = `${identity.issuer}|${identity.subject}`;
      return principal;
    } catch { fail(reply, 401, "unauthorized", "The OIDC access token is invalid or expired."); return null; }
  }
  if (verifier !== undefined) { fail(reply, 401, "unauthorized", "OIDC is enabled; send a short-lived provider-issued JWT."); return null; }
  const principal = await options.store.authenticate(token);
  if (principal === null) { fail(reply, 401, "unauthorized", "The bearer token is not recognized."); return null; }
  return principal;
}
function authorize(principal: AuthPrincipal, allowed: readonly AuthPrincipal["role"][], reply: FastifyReply): boolean {
  if (allowed.includes(principal.role)) return true;
  fail(reply, 403, "unauthorized", "This organization role is not permitted to perform the requested action."); return false;
}
async function sendDashboardFile(reply: FastifyReply, file: string, cacheControl: string): Promise<FastifyReply> {
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) return fail(reply, 404, "not_found", "The dashboard has no built asset at that path. Rebuild it with `pnpm --filter @codecitadel/dashboard build`.");
  return reply.header("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream").header("cache-control", cacheControl).send(bytes);
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store } = options;
  const verifier = options.oidc === undefined ? undefined : new OidcVerifier(options.oidc);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES });
  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, _request, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return fail(reply, 413, "too_large", `The body is larger than ${MAX_UPLOAD_BYTES} bytes. Split the artifacts out of the upload.`);
    const status = error.statusCode ?? 500;
    return status >= 500 ? fail(reply, 500, "invalid_request", "The server could not process this request.") : fail(reply, status, "invalid_request", error.message);
  });
  app.setNotFoundHandler((_request, reply) => fail(reply, 404, "not_found", "No route matches this path."));

  app.get("/api/v1/health", async (): Promise<HealthResponse> => healthResponseSchema.parse({
    schemaVersion: API_SCHEMA_VERSION, status: "ok",
    storage: { driver: store.driver, artifactDriver: options.objectStorage === undefined ? "filesystem" : "s3", schemaVersion: store.schemaVersion },
    limits: { maxUploadBytes: MAX_UPLOAD_BYTES, maxArtifacts: MAX_ARTIFACTS, maxArtifactBytes: MAX_ARTIFACT_BYTES, inlineArtifactBytes: INLINE_ARTIFACT_BYTES },
    limitations: [...BASE_LIMITATIONS, ...(options.objectStorage === undefined ? ["Artifacts use local filesystem storage and are not encrypted at rest."] : []), ...(options.oidc === undefined ? ["OIDC is disabled; database-issued bearer tokens authenticate requests."] : [])],
  }));

  if (options.dashboard !== undefined) {
    const root = path.resolve(options.dashboard.dir); const assets = path.join(root, "assets");
    const serveIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const html = await readFile(path.join(root, "index.html")).catch(() => null);
      if (html === null) return fail(reply, 404, "not_found", "The dashboard has not been built. Run `pnpm --filter @codecitadel/dashboard build` and restart, or start with --no-dashboard.");
      return reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache").header("set-cookie", `${SESSION_COOKIE}=${options.dashboard!.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`).send(html);
    };
    app.get("/", serveIndex); app.get("/index.html", serveIndex);
    app.get("/assets/*", async (request, reply) => {
      const relative = (request.params as { "*": string })["*"]; const target = path.resolve(assets, relative);
      if (!target.startsWith(assets + path.sep)) return fail(reply, 404, "not_found", "No route matches this path.");
      return sendDashboardFile(reply, target, "public, max-age=31536000, immutable");
    });
  }

  app.post("/api/v1/reports", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (!authorize(principal, ["upload", "admin"], reply)) return reply;
    const envelope = reportUploadSchema.safeParse(request.body);
    if (!envelope.success) { const issue = envelope.error.issues[0]; const where = issue && issue.path.length ? ` at ${issue.path.join(".")}` : ""; return fail(reply, 400, "invalid_request", `The upload does not match the API schema${where}: ${issue?.message ?? "invalid body"}.`); }
    const upload = envelope.data; const report = reportSchemaFor(upload.kind).safeParse(upload.report);
    if (!report.success) { const issue = report.error.issues[0]; const where = issue && issue.path.length ? ` at ${issue.path.join(".")}` : ""; return fail(reply, 400, "unsupported_kind", `The report does not match the ${upload.kind} contract${where}: ${issue?.message ?? "invalid report"}.`); }
    const artifacts: { name: string; digest: string; bytes?: Buffer; objectKey?: string; byteLength?: number }[] = [];
    for (const artifact of upload.artifacts) {
      const bytes = Buffer.from(artifact.contentBase64, "base64");
      if (bytes.length === 0) return fail(reply, 400, "invalid_request", `Artifact ${artifact.name} is empty.`);
      if (bytes.length > INLINE_ARTIFACT_BYTES) return fail(reply, 413, "too_large", `Artifact ${artifact.name} exceeds the inline upload limit of ${INLINE_ARTIFACT_BYTES} bytes; use a presigned upload.`);
      const digest = payloadDigest(bytes); if (digest !== artifact.digest) return fail(reply, 400, "invalid_request", `Artifact ${artifact.name} does not match its digest.`);
      artifacts.push({ name: artifact.name, digest, bytes });
    }
    const reportJson = JSON.stringify(upload.report); if (Buffer.byteLength(reportJson) > MAX_REPORT_BYTES) return fail(reply, 413, "too_large", `Report exceeds ${MAX_REPORT_BYTES} bytes.`);
    const run = await store.insertRun({ organizationId: principal.id, repository: upload.repository, kind: upload.kind, origin: upload.origin, capturedAt: upload.capturedAt, receivedAt: new Date().toISOString(), reportJson, outcome: outcomeOf(upload.kind, upload.report), artifacts });
    await store.recordAudit({ organizationId: principal.id, actor: requestActor(request, principal), action: "run.upload", target: run.id });
    return reply.status(202).send(uploadResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, run }));
  });

  app.post("/api/v1/runs/:id/artifacts/:name/upload", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (!authorize(principal, ["upload", "admin"], reply)) return reply;
    if (options.objectStorage === undefined) return fail(reply, 404, "not_found", "Private object storage is not configured.");
    const { id, name } = request.params as { id: string; name: string };
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return fail(reply, 400, "invalid_request", "Artifact name is invalid.");
    const body = request.body as { digest?: unknown; bytes?: unknown };
    if (typeof body?.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.digest) || !Number.isSafeInteger(body.bytes) || Number(body.bytes) <= INLINE_ARTIFACT_BYTES || Number(body.bytes) > MAX_ARTIFACT_BYTES) return fail(reply, 400, "invalid_request", "Provide a sha256 digest and byte count between the inline limit and the artifact maximum.");
    const run = await store.getRun(principal.id, id); if (run === null) return fail(reply, 404, "not_found", `There is no run ${id} in this organization.`);
    if (run.run.artifacts.some((item) => item.name === name)) return fail(reply, 409, "conflict", "An artifact with this name already exists on the run.");
    const signed = await options.objectStorage.createUpload({ organizationId: principal.id, runId: id, name, digest: body.digest, bytes: Number(body.bytes) });
    return reply.status(201).send({ schemaVersion: API_SCHEMA_VERSION, ...signed });
  });

  app.post("/api/v1/runs/:id/artifacts/:name/complete", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (!authorize(principal, ["upload", "admin"], reply)) return reply;
    if (options.objectStorage === undefined) return fail(reply, 404, "not_found", "Private object storage is not configured.");
    const { id, name } = request.params as { id: string; name: string }; const body = request.body as { key?: unknown; digest?: unknown; bytes?: unknown };
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || typeof body?.key !== "string" || !body.key.startsWith(`artifacts/${encodeURIComponent(principal.id)}/${encodeURIComponent(id)}/${name}/`) || typeof body.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.digest) || !Number.isSafeInteger(body.bytes) || Number(body.bytes) <= INLINE_ARTIFACT_BYTES || Number(body.bytes) > MAX_ARTIFACT_BYTES) return fail(reply, 400, "invalid_request", "Artifact completion does not match the signed upload.");
    const run = await store.getRun(principal.id, id); if (run === null) return fail(reply, 404, "not_found", `There is no run ${id} in this organization.`);
    if (run.run.artifacts.some((item) => item.name === name)) return fail(reply, 409, "conflict", "An artifact with this name already exists on the run.");
    try { await options.objectStorage.verifyUpload(body.key, body.digest, Number(body.bytes)); }
    catch { return fail(reply, 400, "invalid_request", "The object is missing or its bytes do not match the declared digest and size."); }
    const artifact = { name, digest: body.digest, byteLength: Number(body.bytes), objectKey: body.key };
    await store.attachArtifact(principal.id, id, artifact);
    await store.recordAudit({ organizationId: principal.id, actor: requestActor(request, principal), action: "artifact.upload", target: `${id}/${name}` });
    return reply.status(201).send({ schemaVersion: API_SCHEMA_VERSION, artifact: { name, digest: body.digest, bytes: Number(body.bytes) } });
  });

  app.get("/api/v1/organizations", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (principal.issuer === null || principal.subject === null) return { schemaVersion: API_SCHEMA_VERSION, organizations: [{ id: principal.id, slug: principal.slug, role: principal.role }] };
    return { schemaVersion: API_SCHEMA_VERSION, organizations: await store.findMembership(principal.issuer, principal.subject) };
  });
  app.post("/api/v1/organizations", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (!authorize(principal, ["admin"], reply)) return reply;
    const body = request.body as { slug?: unknown }; if (typeof body?.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.slug)) return fail(reply, 400, "invalid_request", "Organization slug must be 2-63 lowercase letters, digits, or hyphens.");
    let org;
    try { org = await store.createOrganization(body.slug); }
    catch { return fail(reply, 409, "conflict", "An organization with that slug already exists."); }
    if (principal.issuer !== null && principal.subject !== null) await store.setMembership({ organizationId: org.id, issuer: principal.issuer, subject: principal.subject, role: "admin" });
    await store.recordAudit({ organizationId: org.id, actor: requestActor(request, principal), action: "organization.create", target: org.id });
    if (principal.id && principal.id !== org.id) await store.recordAudit({ organizationId: principal.id, actor: requestActor(request, principal), action: "organization.create", target: org.id });
    return reply.status(201).send({ schemaVersion: API_SCHEMA_VERSION, organization: org });
  });
  app.get("/api/v1/organizations/:id/members", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    const id = (request.params as { id: string }).id; if (principal.id !== id) return fail(reply, 404, "not_found", "Organization not found."); if (!authorize(principal, ["admin"], reply)) return reply;
    return { schemaVersion: API_SCHEMA_VERSION, members: await store.listMembers(id) };
  });
  app.put("/api/v1/organizations/:id/members", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    const id = (request.params as { id: string }).id; if (principal.id !== id) return fail(reply, 404, "not_found", "Organization not found."); if (!authorize(principal, ["admin"], reply)) return reply;
    const body = request.body as { issuer?: unknown; subject?: unknown; role?: unknown };
    if (typeof body?.issuer !== "string" || body.issuer.trim() === "" || body.issuer.length > 500 || typeof body.subject !== "string" || body.subject.trim() === "" || body.subject.length > 500 || !["read_only", "upload", "admin"].includes(String(body.role))) return fail(reply, 400, "invalid_request", "Membership requires a non-empty issuer and subject (up to 500 characters) and role read_only|upload|admin.");
    await store.setMembership({ organizationId: id, issuer: body.issuer, subject: body.subject, role: body.role as "read_only" | "upload" | "admin" });
    await store.recordAudit({ organizationId: id, actor: requestActor(request, principal), action: "membership.set", target: `${body.issuer}|${body.subject}` });
    return reply.status(204).send();
  });
  app.get("/api/v1/audit", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    if (!authorize(principal, ["admin"], reply)) return reply;
    return { schemaVersion: API_SCHEMA_VERSION, events: await store.listAudit(principal.id) };
  });

  app.get("/api/v1/runs", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    const query = request.query as { limit?: string }; const limit = query.limit === undefined ? 50 : Number.parseInt(query.limit, 10);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) return fail(reply, 400, "invalid_request", "--limit must be between 1 and 200.");
    return runListResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, runs: await store.listRuns(principal.id, limit) });
  });
  app.get("/api/v1/runs/:id", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    const { id } = request.params as { id: string }; const detail = await store.getRun(principal.id, id);
    if (detail === null) return fail(reply, 404, "not_found", `There is no run ${id} in this organization.`);
    await store.recordAudit({ organizationId: principal.id, actor: requestActor(request, principal), action: "run.read", target: id });
    return runDetailResponseSchema.parse({ schemaVersion: API_SCHEMA_VERSION, run: detail.run, report: JSON.parse(detail.reportJson) as unknown });
  });
  app.get("/api/v1/runs/:id/artifacts/:name", async (request, reply) => {
    const principal = await authenticate(options, verifier, request, reply); if (principal === null) return reply;
    const { id, name } = request.params as { id: string; name: string }; const artifact = await store.getArtifact(principal.id, id, name);
    if (artifact === null) return fail(reply, 404, "not_found", `There is no artifact ${name} for run ${id} in this organization.`);
    await store.recordAudit({ organizationId: principal.id, actor: requestActor(request, principal), action: "artifact.read", target: `${id}/${name}` });
    if (artifact.storageDriver === "s3") {
      if (options.objectStorage === undefined) return fail(reply, 503, "invalid_request", "Object storage is unavailable.");
      const stream = await options.objectStorage.getStream(artifact.objectKey);
      return reply.header("content-type", "application/octet-stream").header("content-length", String(stream.bytes || artifact.bytes)).header("x-codecitadel-digest", artifact.digest).send(stream.body);
    }
    const local = await store.readArtifact(principal.id, id, name); if (local === null) return fail(reply, 404, "not_found", "Artifact bytes are unavailable.");
    return reply.header("content-type", "application/octet-stream").header("x-codecitadel-digest", local.digest).send(local.bytes);
  });
  return app;
}

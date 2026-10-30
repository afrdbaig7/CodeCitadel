import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createHash as nodeCreateHash } from "node:crypto";
import { payloadDigest, uploadResponseSchema } from "@codecitadel/contracts";
import { ReportStore, S3ArtifactStorage } from "@codecitadel/storage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-hosted-"));
const identity = { issuer: "https://issuer.example.test", subject: "user-1" };
const report = {
  schemaVersion: 1, generatedAt: "2026-10-25T09:00:00.000Z", root: "/repo",
  base: { generatedAt: "2026-10-24T09:00:00.000Z", root: "/repo" }, changed: [],
  graph: { modules: 0, edges: 0, testFiles: 0, externalImports: 0, outsideScope: 0, unresolved: [] },
  impacted: [], tests: { selected: [], notSelected: 0 }, complete: true,
  incompleteReasons: [], limitations: ["No file changed."],
};

let store: ReportStore;
let app: FastifyInstance;
let org: { id: string; slug: string };
let s3: S3ArtifactStorage;
let s3Server: ReturnType<typeof createServer>;
let s3Url: string;
const objects = new Map<string, Buffer>();

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
function authorization(jwt: string, organization = "acme") {
  return { authorization: `Bearer ${jwt}`, "x-codecitadel-organization": organization };
}

beforeAll(async () => {
  store = new ReportStore({ file: path.join(scratch, "db.sqlite"), artifactsDir: path.join(scratch, "artifacts") });
  org = store.ensureOrganization("acme");
  store.setMembership({ organizationId: org.id, ...identity, role: "admin" });

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  s3Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const key = decodeURIComponent(pathname.slice(pathname.indexOf("/artifacts/") + 1));
    if (request.method === "GET" && pathname.endsWith("/.well-known/jwks.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        objects.set(key, bytes);
        response.writeHead(200);
        response.end();
      });
      return;
    }
    if (request.method === "GET") {
      const bytes = objects.get(key);
      if (bytes === undefined) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-length": String(bytes.length) });
      response.end(bytes);
      return;
    }
    response.writeHead(200);
    response.end();
  });
  const port = await listen(s3Server);
  s3Url = `http://127.0.0.1:${port}`;
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  s3 = new S3ArtifactStorage({ bucket: "private-evidence", region: "us-east-1", endpoint: s3Url, forcePathStyle: true });
  app = buildServer({ store, objectStorage: s3, oidc: { issuer: identity.issuer, audience: "codecitadel-api", jwksUrl: `${s3Url}/.well-known/jwks.json` } });
  (globalThis as { hostedPrivateKey?: typeof privateKey }).hostedPrivateKey = privateKey;
}, 30_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  s3?.close();
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  if (s3Server !== undefined) await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  store?.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function jwt(subject = identity.subject, audience = "codecitadel-api"): Promise<string> {
  const privateKey = (globalThis as { hostedPrivateKey?: CryptoKey }).hostedPrivateKey;
  if (privateKey === undefined) throw new Error("OIDC keypair was not initialized.");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(identity.issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
}

describe("OIDC identity and organization authorization", () => {
  it("accepts an issuer-signed short-lived JWT and rejects static bearer tokens", async () => {
    const valid = await app.inject({ method: "GET", url: "/api/v1/runs", headers: authorization(await jwt()) });
    expect(valid.statusCode).toBe(200);
    const staticToken = await app.inject({ method: "GET", url: "/api/v1/runs", headers: authorization("local-admin-token") });
    expect(staticToken.statusCode).toBe(401);
    const wrongAudience = await app.inject({ method: "GET", url: "/api/v1/runs", headers: authorization(await jwt(identity.subject, "elsewhere")) });
    expect(wrongAudience.statusCode).toBe(401);
  });

  it("applies read-only, upload, and admin roles, and retains an audit trail", async () => {
    store.setMembership({ organizationId: org.id, issuer: identity.issuer, subject: "reader", role: "read_only" });
    store.setMembership({ organizationId: org.id, issuer: identity.issuer, subject: "uploader", role: "upload" });
    const reader = authorization(await jwt("reader"));
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/reports", headers: reader, payload: { schemaVersion: 1 } });
    expect(forbidden.statusCode).toBe(403);

    const uploaded = await app.inject({ method: "POST", url: "/api/v1/reports", headers: authorization(await jwt("uploader")), payload: {
      schemaVersion: 1, origin: "user-ci", kind: "impact", repository: { name: "repo", commit: null, branch: null },
      capturedAt: "2026-10-25T09:00:00.000Z", report, artifacts: [],
    } });
    expect(uploaded.statusCode).toBe(202);
    const audit = await app.inject({ method: "GET", url: "/api/v1/audit", headers: authorization(await jwt()) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events.map((event: { action: string }) => event.action)).toContain("run.upload");
    const readerAudit = await app.inject({ method: "GET", url: "/api/v1/audit", headers: reader });
    expect(readerAudit.statusCode).toBe(403);
  });

  it("does not allow selecting an organization without membership", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/runs", headers: authorization(await jwt(), "other") });
    expect(response.statusCode).toBe(403);
  });

  it("creates an organization, grants a role, and lists members without leaking other tenants", async () => {
    const admin = authorization(await jwt());
    const created = await app.inject({ method: "POST", url: "/api/v1/organizations", headers: admin, payload: { slug: "team-two" } });
    expect(created.statusCode).toBe(201);
    const team = created.json().organization as { id: string; slug: string };
    const membership = await app.inject({ method: "PUT", url: `/api/v1/organizations/${org.id}/members`, headers: admin, payload: { issuer: identity.issuer, subject: "new-user", role: "upload" } });
    expect(membership.statusCode).toBe(204);
    const members = await app.inject({ method: "GET", url: `/api/v1/organizations/${org.id}/members`, headers: admin });
    expect(members.json().members).toEqual(expect.arrayContaining([expect.objectContaining({ subject: "new-user", role: "upload" })]));
    const outside = await app.inject({ method: "GET", url: `/api/v1/organizations/${team.id}/members`, headers: admin });
    expect(outside.statusCode).toBe(404);
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/organizations", headers: admin, payload: { slug: "team-two" } });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const createdAudit = await app.inject({ method: "GET", url: "/api/v1/audit", headers: admin });
    expect(createdAudit.json().events.map((event: { action: string }) => event.action)).toContain("organization.create");
  });
});

describe("private S3-compatible artifacts", () => {
  it("presigns a >1 MiB artifact, verifies it, records metadata, and streams it back", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/reports", headers: authorization(await jwt()), payload: {
      schemaVersion: 1, origin: "user-ci", kind: "impact", repository: { name: "s3-repo", commit: null, branch: null },
      capturedAt: "2026-10-25T09:00:00.000Z", report, artifacts: [],
    } });
    const run = uploadResponseSchema.parse(created.json()).run;
    const bytes = Buffer.alloc(1024 * 1024 + 64, 0x5a);
    const digest = `sha256:${nodeCreateHash("sha256").update(bytes).digest("hex")}`;
    const initiated = await app.inject({ method: "POST", url: `/api/v1/runs/${run.id}/artifacts/bundle.bin/upload`, headers: authorization(await jwt()), payload: { digest, bytes: bytes.length } });
    expect(initiated.statusCode, initiated.body).toBe(201);
    const signed = initiated.json() as { url: string; headers: Record<string, string>; key: string };
    const put = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
    expect(put.status).toBe(200);
    const completed = await app.inject({ method: "POST", url: `/api/v1/runs/${run.id}/artifacts/bundle.bin/complete`, headers: authorization(await jwt()), payload: { digest, bytes: bytes.length, key: signed.key } });
    expect(completed.statusCode).toBe(201);
    const fetched = await app.inject({ method: "GET", url: `/api/v1/runs/${run.id}/artifacts/bundle.bin`, headers: authorization(await jwt()) });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["x-codecitadel-digest"]).toBe(digest);
    expect(fetched.rawPayload).toEqual(bytes);
    expect((await store.getRun(org.id, run.id))?.run.artifacts).toContainEqual({ name: "bundle.bin", digest, bytes: bytes.length });
  });

  it("rejects cross-tenant artifact initiation", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/runs/run_missing/artifacts/x.bin/upload`, headers: authorization(await jwt()), payload: { digest: payloadDigest("x"), bytes: 2 * 1024 * 1024 } });
    expect(response.statusCode).toBe(404);
  });
});

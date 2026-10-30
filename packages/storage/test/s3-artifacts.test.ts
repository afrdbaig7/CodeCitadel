import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { S3ArtifactStorage } from "../src/s3-artifacts.js";

let server: ReturnType<typeof createServer>;
let endpoint: string;
const objects = new Map<string, Buffer>();

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parsed = new URL(request.url ?? "/", "http://localhost");
    const key = decodeURIComponent(parsed.pathname.split("/").slice(2).join("/"));
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        objects.set(key, bytes);
        const checksum = request.headers["x-amz-checksum-sha256"];
        if (typeof checksum === "string") response.setHeader("x-amz-checksum-sha256", checksum);
        response.writeHead(200);
        response.end();
      });
      return;
    }
    const bytes = objects.get(key);
    if (bytes !== undefined && parsed.searchParams.has("x-id")) {
      response.writeHead(200, { "content-length": String(bytes.length), "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64") });
      response.end(bytes);
      return;
    }
    if (bytes === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-length": String(bytes.length) });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

describe("S3ArtifactStorage", () => {
  it("refuses invalid bucket, TTL, name, and digest metadata", async () => {
    expect(() => new S3ArtifactStorage({ bucket: " ", region: "us-east-1" })).toThrow(/bucket/);
    expect(() => new S3ArtifactStorage({ bucket: "private", region: "us-east-1", uploadTtlSeconds: 10 })).toThrow(/lifetime/);
    const storage = new S3ArtifactStorage({ bucket: "private", region: "us-east-1", endpoint });
    await expect(storage.createUpload({ organizationId: "org", runId: "run", name: "../bad", digest: "sha256:" + "a".repeat(64), bytes: 1 })).rejects.toThrow(/name/);
    await expect(storage.createUpload({ organizationId: "org", runId: "run", name: "good.bin", digest: "bad", bytes: 1 })).rejects.toThrow(/digest/);
    storage.close();
  });

  it("presigns private writes with a bounded expiry and verifies and streams bytes", async () => {
    const storage = new S3ArtifactStorage({ bucket: "private-evidence", region: "us-east-1", endpoint, forcePathStyle: true, uploadTtlSeconds: 120 });
    const bytes = Buffer.from("private evidence bytes");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const before = Date.now();
    const signed = await storage.createUpload({ organizationId: "org_1", runId: "run_1", name: "trace.bin", digest, bytes: bytes.length });
    expect(signed.key).toMatch(/^artifacts\/org_1\/run_1\/trace.bin\//);
    expect(Date.parse(signed.expiresAt)).toBeGreaterThanOrEqual(before + 119_000);
    expect(signed.url).toContain("X-Amz-Signature=");
    const put = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
    expect(put.status).toBe(200);
    expect(objects.size).toBe(1);
    await expect(storage.verifyUpload(signed.key, digest, bytes.length)).resolves.toBeUndefined();
    await expect(storage.verifyUpload(signed.key, `sha256:${"0".repeat(64)}`, bytes.length)).rejects.toThrow(/match/);
    const stream = await storage.getStream(signed.key);
    const collected: Buffer[] = [];
    for await (const chunk of stream.body) collected.push(Buffer.from(chunk));
    expect(Buffer.concat(collected)).toEqual(bytes);
    expect(stream.bytes).toBe(bytes.length);
    storage.close();
  });
});

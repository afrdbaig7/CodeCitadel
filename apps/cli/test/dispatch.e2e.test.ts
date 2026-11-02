import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { managedRunResponseSchema } from "@codecitadel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const serverEntry = path.join(repoRoot, "apps", "api", "dist", "main.js");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-dispatch-e2e-"));

const TOKEN = "cc_dispatch_test_token";
let server: ChildProcess;
let baseUrl = "";

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const run = await exec(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout: run.stdout, stderr: run.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 2, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  server = spawn(
    process.execPath,
    [
      serverEntry,
      "--port",
      String(port),
      "--data-dir",
      path.join(scratch, "data"),
      "--token",
      TOKEN,
      "--organization",
      "acme",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server failed to start within timeout");
}, 20_000);

afterAll(() => {
  if (server) {
    server.kill("SIGTERM");
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

describe("codecitadel dispatch (E2E)", () => {
  it("enqueues a managed run and returns valid JSON response", async () => {
    const result = await cli([
      "dispatch",
      "payment-service",
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--check",
      "scan",
      "--commit",
      "c0ffee1",
      "--format",
      "json",
    ]);

    expect(result.code).toBe(0);
    const parsed = managedRunResponseSchema.safeParse(JSON.parse(result.stdout));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("queued");
      expect(parsed.data.statusUrl).toContain("/api/v1/runs/");
    }
  });

  it("prints human-readable summary in text format by default", async () => {
    const result = await cli([
      "dispatch",
      "auth-service",
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--check",
      "scan",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CodeCitadel Managed Execution Enqueued");
    expect(result.stdout).toContain("Run ID:");
    expect(result.stdout).toContain("Status:     queued");
    expect(result.stdout).toContain(`Status URL: ${baseUrl}/api/v1/runs/`);
  });

  it("takes the authentication token from CODECITADEL_TOKEN environment variable", async () => {
    const result = await cli(
      [
        "dispatch",
        "worker-service",
        "--server",
        baseUrl,
        "--check",
        "scan",
        "--format",
        "json",
      ],
      { CODECITADEL_TOKEN: TOKEN },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"status": "queued"');
  });

  it("refuses to dispatch when authentication token is rejected", async () => {
    const result = await cli([
      "dispatch",
      "payment-service",
      "--server",
      baseUrl,
      "--token",
      "invalid-token",
    ]);

    expect(result.code).toBe(1); // policy breach
    expect(result.stderr).toContain("authentication rejected");
  });

  it("refuses to dispatch when token is missing entirely", async () => {
    const result = await cli(
      ["dispatch", "payment-service", "--server", baseUrl],
      { CODECITADEL_TOKEN: "" },
    );

    expect(result.code).toBe(2); // error
    expect(result.stderr).toContain("Managed dispatch requires an authenticated token");
  });

  it("reports unreachable control plane gracefully", async () => {
    const result = await cli([
      "dispatch",
      "payment-service",
      "--server",
      "http://127.0.0.1:59999",
      "--token",
      TOKEN,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed to connect to control plane");
  });
});

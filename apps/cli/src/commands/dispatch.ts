import {
  API_SCHEMA_VERSION,
  EXIT_CODES,
  managedRunResponseSchema,
  reportKindSchema,
  runDetailResponseSchema,
  type ExitCode,
  type ReportKind,
} from "@codecitadel/contracts";

import { UsageError, parsePositiveInt } from "../errors.js";

export interface DispatchCommandOptions {
  server?: string;
  token?: string;
  check?: string;
  commit?: string;
  branch?: string;
  timeoutMs?: string;
  format?: string;
  wait?: boolean;
}

const DEFAULT_SERVER = "http://127.0.0.1:4317";
const FORMATS = ["text", "json"] as const;

function parseFormat(value: string | undefined): "text" | "json" {
  const format = value ?? "text";
  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    throw new UsageError(`--format must be one of text, json, received "${format}".`);
  }
  return format as "text" | "json";
}

function resolveServer(value: string | undefined): string {
  const server = value ?? process.env.CODECITADEL_SERVER ?? DEFAULT_SERVER;
  try {
    const url = new URL(server);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error();
    }
    return server.replace(/\/+$/, "");
  } catch {
    throw new UsageError(`--server must be a valid http or https URL, received "${server}".`);
  }
}

function resolveToken(value: string | undefined): string {
  const token = value ?? process.env.CODECITADEL_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new UsageError(
      "Managed dispatch requires an authenticated token. Pass --token or set CODECITADEL_TOKEN.",
    );
  }
  return token.trim();
}

export async function runDispatchCommand(
  repositoryNameArg: string | undefined,
  options: DispatchCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format);
  const server = resolveServer(options.server);
  const token = resolveToken(options.token);
  const timeoutMs = options.timeoutMs
    ? parsePositiveInt(options.timeoutMs, "--timeout-ms")
    : 60_000;

  const repoName = repositoryNameArg?.trim() || "default-repository";
  const checkKind = (options.check ?? "scan") as ReportKind;
  if (!reportKindSchema.options.includes(checkKind)) {
    throw new UsageError(
      `--check must be one of ${reportKindSchema.options.join(", ")}, received "${options.check}".`,
    );
  }

  const payload = {
    schemaVersion: API_SCHEMA_VERSION,
    repository: {
      name: repoName,
      commit: options.commit ?? null,
      branch: options.branch ?? null,
    },
    check: {
      kind: checkKind,
      options: {},
    },
    budget: {
      timeoutMs,
    },
  };

  const dispatchUrl = `${server}/api/v1/runs/managed`;
  let res: Response;
  try {
    res = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codecitadel: failed to connect to control plane at ${server}: ${message}\n`);
    return EXIT_CODES.error;
  }

  if (res.status === 401 || res.status === 403) {
    const body = await res.text();
    process.stderr.write(`codecitadel: authentication rejected by ${server}: ${body}\n`);
    return EXIT_CODES.policyBreach;
  }

  if (res.status !== 202) {
    const body = await res.text();
    process.stderr.write(`codecitadel: dispatch failed (${res.status}): ${body}\n`);
    return EXIT_CODES.error;
  }

  const json = await res.json();
  const managedResponse = managedRunResponseSchema.parse(json);

  if (!options.wait) {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(managedResponse, null, 2)}\n`);
    } else {
      process.stdout.write(`=== CodeCitadel Managed Execution Enqueued ===\n`);
      process.stdout.write(`Run ID:     ${managedResponse.runId}\n`);
      process.stdout.write(`Status:     ${managedResponse.status}\n`);
      process.stdout.write(`Status URL: ${server}${managedResponse.statusUrl}\n`);
      process.stdout.write(`Queued At:  ${managedResponse.queuedAt}\n`);
    }
    return EXIT_CODES.ok;
  }

  // Polling loop when --wait is requested
  process.stderr.write(`Waiting for managed run ${managedResponse.runId} to complete...\n`);
  const statusEndpoint = `${server}${managedResponse.statusUrl}`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const pollRes = await fetch(statusEndpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (pollRes.ok) {
        const detailJson = await pollRes.json();
        const detail = runDetailResponseSchema.parse(detailJson);
        if (detail.run.status === "completed") {
          if (format === "json") {
            process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
          } else {
            process.stdout.write(`=== CodeCitadel Managed Execution Finished ===\n`);
            process.stdout.write(`Run ID:   ${detail.run.id}\n`);
            process.stdout.write(`Status:   ${detail.run.status}\n`);
            process.stdout.write(`Outcome:  ${detail.run.outcome ?? "completed"}\n`);
          }
          return EXIT_CODES.ok;
        }
        if (detail.run.status === "failed" || detail.run.status === "cancelled") {
          process.stderr.write(`codecitadel: run ended with status ${detail.run.status}.\n`);
          return EXIT_CODES.policyBreach;
        }
      }
    } catch {}
  }

  process.stderr.write(`codecitadel: timeout waiting for run ${managedResponse.runId}.\n`);
  return EXIT_CODES.policyBreach;
}

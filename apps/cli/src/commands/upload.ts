import { readFile } from "node:fs/promises";

import {
  API_SCHEMA_VERSION,
  EXIT_CODES,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  MAX_UPLOAD_BYTES,
  apiErrorSchema,
  payloadDigest,
  reportUploadSchema,
  uploadOriginSchema,
  uploadResponseSchema,
  type ExitCode,
  type StoredRun,
  type UploadOrigin,
} from "@codecitadel/contracts";

import { UsageError, parsePositiveInt } from "../errors.js";
import {
  artifactName,
  assertReportKind,
  inferReportKind,
  reportIdentity,
  repositoryName,
} from "../upload-envelope.js";

export interface UploadCommandOptions {
  server?: string;
  token?: string;
  kind?: string;
  repository?: string;
  commit?: string;
  branch?: string;
  origin?: string;
  artifact?: string[];
  timeoutMs?: string;
  format?: string;
}

const ENDPOINT_PATH = "/api/v1/reports";
const FORMATS = ["text", "json"] as const;
const DEFAULT_TIMEOUT_MS = 60_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseFormat(value: string | undefined): "text" | "json" {
  const format = value ?? "text";
  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for upload, received "${format}".`,
    );
  }
  return format as "text" | "json";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/**
 * The base URL of the control plane.
 *
 * A bearer token is refused over plaintext http to anything but a loopback
 * address: this milestone's server binds 127.0.0.1 and has no TLS, so a remote
 * plaintext upload would put the token on the wire for anyone on the path.
 */
function controlPlaneUrl(value: string | undefined): URL {
  const raw = value?.trim() ?? "";
  if (raw === "") {
    throw new UsageError(
      "upload requires --server <url>, for example --server http://127.0.0.1:4317.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--server must be an absolute URL, received "${raw}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(
      `--server must be http or https, received "${url.protocol.replace(":", "")}".`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new UsageError(
      `Refusing to send a bearer token over plaintext http to ${url.hostname}. ` +
        "Use https, or a loopback address (127.0.0.1, localhost, ::1) for a local control plane.",
    );
  }
  return url;
}

function bearerToken(value: string | undefined): string {
  const token = (value ?? process.env.CODECITADEL_TOKEN ?? "").trim();
  if (token === "") {
    throw new UsageError(
      "upload needs a bearer token: pass --token <value> or set CODECITADEL_TOKEN. " +
        "The token is never written into a report, an artifact, or the output.",
    );
  }
  return token;
}

function uploadOrigin(value: string | undefined): UploadOrigin {
  const raw = value?.trim() ?? "local";
  const parsed = uploadOriginSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      raw === "managed"
        ? "An upload can only claim --origin local or --origin user-ci. Managed execution is recorded by the platform that ran the checks, never asserted by the client that sends them."
        : `--origin must be local or user-ci, received "${raw}".`,
    );
  }
  return parsed.data;
}

function boundedLabel(value: string | undefined, flag: string): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return null;
  }
  if (trimmed.length > 200) {
    throw new UsageError(`${flag} must be 200 characters or fewer.`);
  }
  return trimmed;
}

async function readReport(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read the report at ${file}: ${(error as Error).message}`);
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new UsageError(
      `The report at ${file} is ${formatBytes(bytes)}, more than the upload limit of ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Reports are summaries; large raw output belongs in an artifact the report references.",
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new UsageError(`The report at ${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Exactly the three fields the upload contract accepts: the envelope is strict. */
interface PreparedArtifact {
  name: string;
  digest: string;
  contentBase64: string;
}

async function prepareArtifacts(files: readonly string[]): Promise<PreparedArtifact[]> {
  if (files.length > MAX_ARTIFACTS) {
    throw new UsageError(
      `An upload carries at most ${MAX_ARTIFACTS} artifacts; ${files.length} were given.`,
    );
  }
  const prepared: PreparedArtifact[] = [];
  for (const file of files) {
    const name = artifactName(file);
    if (prepared.some((artifact) => artifact.name === name)) {
      throw new UsageError(
        `Two artifacts would be stored as "${name}". The control plane keys artifacts by name, so give one of them a different file name.`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      throw new UsageError(`Cannot read the artifact at ${file}: ${(error as Error).message}`);
    }
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new UsageError(
        `The artifact ${file} is ${formatBytes(bytes.length)}, more than the per-artifact limit of ${formatBytes(MAX_ARTIFACT_BYTES)}.`,
      );
    }
    prepared.push({
      name,
      digest: payloadDigest(bytes),
      contentBase64: bytes.toString("base64"),
    });
  }
  return prepared;
}

function controlPlaneRoot(url: URL): string {
  return url.href.replace(/\/+$/, "");
}

function renderUploadText(url: URL, run: StoredRun): string {
  const commit = run.repository.commit === null ? "" : ` @ ${run.repository.commit}`;
  const branch = run.repository.branch === null ? "" : ` on ${run.repository.branch}`;
  const lines = [
    `uploaded ${run.kind} report → ${run.id}  (${run.organizationId})`,
    `  repository ${run.repository.name}${commit}${branch}`,
    `  captured   ${run.capturedAt} (the report's own timestamp)`,
    `  origin     ${run.origin} — captured outside this platform; never managed execution`,
    `  outcome    ${run.outcome ?? "(the report carries no verdict)"}`,
    `  report     ${run.reportDigest}  ${formatBytes(run.bytes)}`,
  ];
  if (run.artifacts.length > 0) {
    lines.push(`  artifacts (${run.artifacts.length})`);
    for (const artifact of run.artifacts) {
      lines.push(`    ${artifact.name}  ${artifact.digest}  ${formatBytes(artifact.bytes)}`);
    }
  }
  lines.push(`  read back  ${controlPlaneRoot(url)}/api/v1/runs/${run.id}`);
  lines.push(
    "",
    "The control plane validated the report against its contract and stored it. It did not execute anything, and storing a report is not evidence that the checks it describes ran.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `codecitadel upload <report> --server <url> [options]`
 *
 * Sends one stored report to a CodeCitadel control plane. This reads a file the
 * operator already produced and posts it; it executes no repository code and
 * writes nothing locally.
 *
 * The envelope is validated here with the same contracts the server enforces, so
 * a rejected upload is usually a rejected report, refused before the network is
 * touched. Origin is limited to `local` and `user-ci`: an upload cannot claim
 * this platform ran the checks.
 *
 * Exit codes: 0 when the control plane stored the report, 2 for every other
 * outcome (bad invocation, contract mismatch, refused token, unreachable server).
 */
export async function runUploadCommand(
  reportPath: string,
  options: UploadCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format);
  const url = controlPlaneUrl(options.server);
  const token = bearerToken(options.token);
  const origin = uploadOrigin(options.origin);
  const timeoutMs = parsePositiveInt(options.timeoutMs ?? `${DEFAULT_TIMEOUT_MS}`, "--timeout-ms");

  const document = await readReport(reportPath);
  const kind = inferReportKind(document, options.kind, `The report at ${reportPath}`);
  assertReportKind(kind, document, `The report at ${reportPath}`);

  const identity = reportIdentity(kind, document);
  if (identity.capturedAt === null) {
    throw new UsageError(
      `The report at ${reportPath} carries no capture time, and the control plane needs one to file it. ` +
        "Re-create the report with a command that records when it ran.",
    );
  }

  const named = boundedLabel(options.repository, "--repository");
  const derived = named ?? repositoryName(identity.root);
  if (derived === null) {
    throw new UsageError(
      `The ${kind} report records no root directory, so upload cannot tell which repository this is. Pass --repository <name>.`,
    );
  }

  const artifacts = await prepareArtifacts(options.artifact ?? []);
  const envelope = reportUploadSchema.safeParse({
    schemaVersion: API_SCHEMA_VERSION,
    origin,
    kind,
    repository: {
      name: derived,
      commit: boundedLabel(options.commit, "--commit"),
      branch: boundedLabel(options.branch, "--branch"),
    },
    capturedAt: identity.capturedAt,
    report: document,
    artifacts,
  });
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new UsageError(
      `The upload envelope for ${reportPath} does not satisfy API schema version ${API_SCHEMA_VERSION}${location}: ${issue?.message ?? "invalid envelope"}.`,
    );
  }

  const body = JSON.stringify(envelope.data);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new UsageError(
      `The upload is ${formatBytes(bytes)}, more than the limit of ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Leave large artifacts out: the report describes them, and a control plane is not a file host.",
    );
  }

  const endpoint = new URL(ENDPOINT_PATH, url);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const failure = error as { name?: string; cause?: { code?: string }; message?: string };
    const detail =
      failure.name === "TimeoutError"
        ? `timed out after ${timeoutMs} ms`
        : (failure.cause?.code ?? failure.message ?? "the request failed");
    throw new UsageError(
      `Cannot reach the control plane at ${endpoint.href}: ${detail}. ` +
        "Check that `codecitadel-server` is running and that --server names it.",
    );
  }

  const text = await response.text();
  if (response.status !== 202) {
    const problem = apiErrorSchema.safeParse(safeJson(text));
    const described = problem.success
      ? `${problem.data.error.code}: ${problem.data.error.message}`
      : text.trim().slice(0, 300) || response.statusText;
    throw new UsageError(`The control plane refused the upload (${response.status}): ${described}`);
  }

  const stored = uploadResponseSchema.safeParse(safeJson(text));
  if (!stored.success) {
    const issue = stored.error.issues[0];
    const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new UsageError(
      `The control plane stored the report but answered with a response this build does not understand (API schema version ${API_SCHEMA_VERSION})${location}: ${issue?.message ?? "invalid response"}.`,
    );
  }

  process.stdout.write(
    format === "json"
      ? `${JSON.stringify(stored.data, null, 2)}\n`
      : renderUploadText(url, stored.data.run),
  );
  return EXIT_CODES.ok;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import path from "node:path";

import { API_SCHEMA_VERSION } from "@codecitadel/contracts";
import { ReportStore } from "@codecitadel/storage";

import { buildServer } from "./index.js";

interface StartOptions {
  port: number;
  host: string;
  dataDir: string;
  organizationSlug: string;
  token: string | undefined;
}

function parseArgs(argv: readonly string[]): StartOptions {
  const options: StartOptions = {
    port: 4317,
    host: "127.0.0.1",
    dataDir: path.resolve(".codecitadel", "server"),
    organizationSlug: "local",
    token: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--port": {
        if (value === undefined || !/^\d+$/.test(value)) {
          throw new Error("--port needs a number.");
        }
        options.port = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "--data-dir": {
        if (value === undefined) {
          throw new Error("--data-dir needs a path.");
        }
        options.dataDir = path.resolve(value);
        index += 1;
        break;
      }
      case "--organization": {
        if (value === undefined || value.trim() === "") {
          throw new Error("--organization needs a slug.");
        }
        options.organizationSlug = value.trim();
        index += 1;
        break;
      }
      case "--token": {
        if (value === undefined || value.trim() === "") {
          throw new Error("--token needs a value.");
        }
        options.token = value.trim();
        index += 1;
        break;
      }
      case "--help": {
        process.stdout.write(
          [
            "Usage: codecitadel-server [options]",
            "",
            "  --port <n>            listen port (default 4317)",
            "  --data-dir <dir>      SQLite database and artifacts (default .codecitadel/server)",
            "  --organization <slug> organization the token belongs to (default local)",
            "  --token <value>       use this bearer token instead of generating one",
            "",
            "Binds to 127.0.0.1 only: this is a local control plane, not a hosted service.",
            "",
          ].join("\n"),
        );
        process.exit(0);
      }
      default: {
        if (flag !== undefined && flag.startsWith("--")) {
          throw new Error(`Unknown option ${flag}. Use --help.`);
        }
      }
    }
  }
  return options;
}

async function main(): Promise<number> {
  let options: StartOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`codecitadel-server: ${(error as Error).message}\n`);
    return 2;
  }

  const store = new ReportStore({
    file: path.join(options.dataDir, "evidence.db"),
    artifactsDir: path.join(options.dataDir, "artifacts"),
  });
  const organization = store.ensureOrganization(options.organizationSlug);
  const token = options.token ?? `cc_${randomBytes(24).toString("hex")}`;
  store.issueToken({ organizationId: organization.id, token, label: "local operator" });

  const app = buildServer({ store });
  try {
    await app.listen({ port: options.port, host: options.host });
  } catch (error) {
    store.close();
    process.stderr.write(`codecitadel-server: cannot listen: ${(error as Error).message}\n`);
    return 2;
  }

  process.stdout.write(
    [
      `codecitadel local API ${API_SCHEMA_VERSION} listening on http://${options.host}:${options.port}`,
      `organization ${organization.slug} (${organization.id})`,
      `token ${token}`,
      `data ${path.join(options.dataDir, "evidence.db")}`,
      "This is a local control plane. It validates and stores uploaded evidence; it does not execute code.",
      options.token === undefined ? "" : "(--token was provided, so a new token was also issued.)",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return 0;
}

void main().then((code) => {
  if (code !== 0) {
    process.exitCode = code;
  }
});

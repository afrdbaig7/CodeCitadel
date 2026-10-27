import { createPool, migrate } from "./db.ts";
import { buildServer } from "./server.ts";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is required, for example postgres://postgres:postgres@127.0.0.1:55432/codecitadel",
    );
  }
  return url;
}

const pool = createPool(requireDatabaseUrl());
const migration = await migrate(pool);
for (const file of migration.applied) {
  process.stderr.write(`applied ${file}\n`);
}

const app = buildServer(pool);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
process.stderr.write(`shopping-api listening on http://${host}:${port}\n`);

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
}

process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

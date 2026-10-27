import { createPool, migrate } from "./db.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  process.stderr.write("DATABASE_URL is required to migrate the demo database.\n");
  process.exit(2);
}

const pool = createPool(url);
try {
  const result = await migrate(pool);
  for (const file of result.skipped) {
    process.stdout.write(`already applied ${file}\n`);
  }
  for (const file of result.applied) {
    process.stdout.write(`applied ${file}\n`);
  }
  if (result.applied.length === 0) {
    process.stdout.write("nothing to apply\n");
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

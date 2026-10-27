import { runControlPlaneMigrate } from "./cli.js";

const args = process.argv.slice(2);
const { result, exitCode } = await runControlPlaneMigrate(args);
if (exitCode !== 0) {
  process.stderr.write(`controlplane migrate: ${result.storePath || "invalid root"}\n`);
  process.exit(exitCode);
}
process.stdout.write(`controlplane store ${result.storePath}\n`);
process.stdout.write(`manifest  ${result.manifestPath}\n`);
process.stdout.write(`sourceRoot ${result.sourceRoot}\n`);
process.stdout.write(`appliedBy ${result.appliedBy}\n`);
process.stdout.write(`actor     ${result.actor}\n`);

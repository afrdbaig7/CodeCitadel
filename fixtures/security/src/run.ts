// Intentionally vulnerable fixture: the command string is interpreted by a shell.
import { spawn } from "node:child_process";

export function runCommand(command: string) {
  return spawn(command, { shell: true, stdio: "inherit" });
}

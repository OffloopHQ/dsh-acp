import { spawn } from "node:child_process";

export async function run(command, args, options = {}) {
  const capture = options.capture === true;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: capture
        ? ["ignore", "pipe", options.quiet === true ? "ignore" : "inherit"]
        : "inherit",
    });
    const chunks = [];
    if (capture && child.stdout !== null) {
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(capture ? Buffer.concat(chunks).toString("utf8") : "");
        return;
      }
      reject(
        new Error(
          `${command} exited ${code === null ? `for signal ${signal ?? "unknown"}` : `with code ${code}`}`,
        ),
      );
    });
  });
}

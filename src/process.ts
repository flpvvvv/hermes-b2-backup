import { execFile } from "node:child_process";

export function runCommand(
  command: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(
    command,
    args,
    { timeout: options.timeout, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr });
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    },
  );
  return promise;
}

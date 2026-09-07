import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const MAX_OUTPUT_BUFFER_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS_FOR_MODEL = 4000;

export interface TestRunResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Runs the given shell command in the project's root directory. This
 * executes whatever command config or auto-detection produced, only ever
 * call this against a project you trust the test scripts of.
 */
export async function runTests(rootPath: string, command: string, timeoutMs: number): Promise<TestRunResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: rootPath,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
    });
    return {
      passed: true,
      output: truncate(`${stdout}\n${stderr}`.trim()),
      exitCode: 0,
      timedOut: false,
    };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; signal?: string };
    const timedOut = Boolean(execError.signal === "SIGTERM" && execError.killed);
    return {
      passed: false,
      output: truncate(`${execError.stdout ?? ""}\n${execError.stderr ?? ""}`.trim() || String(error)),
      exitCode: execError.code ?? null,
      timedOut,
    };
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS_FOR_MODEL) {
    return text;
  }
  // Keep the tail: for test failures the actual assertion/error is almost
  // always at the end of the output, not the start.
  return `[output truncated, showing last ${MAX_OUTPUT_CHARS_FOR_MODEL} characters]\n${text.slice(-MAX_OUTPUT_CHARS_FOR_MODEL)}`;
}

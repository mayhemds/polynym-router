import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_BUFFER_BYTES = 10 * 1024 * 1024;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_DIFF_BUFFER_BYTES,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = isExecError(error) ? error.stderr?.toString().trim() : undefined;
    throw new GitError(`git ${args.join(" ")} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`);
  }
}

function isExecError(error: unknown): error is { stderr?: Buffer | string } {
  return typeof error === "object" && error !== null && "stderr" in error;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result === "true";
  } catch {
    return false;
  }
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const status = await git(cwd, ["status", "--porcelain"]);
  return status.length === 0;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function createTaskBranch(cwd: string, branchName: string): Promise<void> {
  await git(cwd, ["checkout", "-b", branchName]);
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
  await git(cwd, ["checkout", branchName]);
}

/** Diff of the current working tree against HEAD, i.e. everything not yet committed on this branch. */
export async function getWorkingDiff(cwd: string): Promise<string> {
  return git(cwd, ["diff", "HEAD"]);
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function slugifyForBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "task";
}

export async function listTrackedFiles(cwd: string, maxEntries: number): Promise<string[]> {
  const output = await git(cwd, ["ls-files"]);
  if (!output) return [];
  return output.split("\n").slice(0, maxEntries);
}

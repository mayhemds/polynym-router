import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { loadProjectContext } from "../projects/context.js";
import { lookupProjectEntry } from "../projects/registry.js";
import { getProvider } from "../providers/index.js";
import { parseFileBlocks, resolveSafeFilePath, FileChangeError } from "./parseFileBlocks.js";
import { detectTestCommand } from "../testing/detect.js";
import { runTests } from "../testing/run.js";
import {
  isGitRepo,
  isWorkingTreeClean,
  getCurrentBranch,
  createTaskBranch,
  checkoutBranch,
  getWorkingDiff,
  commitAll,
  listTrackedFiles,
  slugifyForBranch,
} from "../git/repo.js";
import { logRequest } from "../telemetry/log.js";

export interface TaskAgentInput {
  task: string;
  project?: string;
  projectPath?: string;
  maxImplementCycles?: number;
  maxReviewCycles?: number;
  testTimeoutMs?: number;
}

export type TaskStatus = "committed_clean" | "committed_needs_review" | "committed_tests_failing";

export interface TaskAgentResult {
  branch: string;
  baseBranch: string;
  project?: string;
  filesChanged: string[];
  testCommand?: string;
  testsPassed: boolean | null;
  testOutput?: string;
  reviewApproved: boolean | null;
  reviewFeedback?: string;
  implementAttempts: number;
  reviewCycles: number;
  commitSha: string;
  status: TaskStatus;
  summary: string;
}

export class TaskAgentError extends Error {
  public readonly statusHint: number;
  constructor(message: string, statusHint: number) {
    super(message);
    this.name = "TaskAgentError";
    this.statusHint = statusHint;
  }
}

const DEFAULT_MAX_IMPLEMENT_CYCLES = 2;
const DEFAULT_MAX_REVIEW_CYCLES = 1;
const DEFAULT_TEST_TIMEOUT_MS = 5 * 60_000;
const MAX_FILES_PER_ATTEMPT = 50;
const MAX_TOTAL_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_TRACKED_FILES_LISTED = 300;
const MAX_DIFF_CHARS_FOR_REVIEWER = 6000;
const IMPLEMENTER_MAX_TOKENS = 8000;
const REVIEWER_MAX_TOKENS = 2000;

export async function runCodingTask(input: TaskAgentInput): Promise<TaskAgentResult> {
  const config = loadConfig();

  let context;
  try {
    context = await loadProjectContext(input.project, input.projectPath, config.projects, config.allowedRoots);
  } catch (error) {
    throw new TaskAgentError(error instanceof Error ? error.message : "Invalid project path", 400);
  }

  if (!context.resolvedPath) {
    throw new TaskAgentError(
      'A "project" or "projectPath" is required for coding tasks, there is nothing to branch or commit in otherwise.',
      400
    );
  }
  const projectRoot = context.resolvedPath;

  if (!(await isGitRepo(projectRoot))) {
    throw new TaskAgentError(
      `"${projectRoot}" is not a git repository. Run "git init" there first, the branch-per-task safety model depends on git.`,
      400
    );
  }
  if (!(await isWorkingTreeClean(projectRoot))) {
    throw new TaskAgentError(
      `"${projectRoot}" has uncommitted changes. Commit or stash them first, so this never mixes its edits with your in-progress work.`,
      409
    );
  }

  const baseBranch = await getCurrentBranch(projectRoot);
  const branch = `ai/task-${slugifyForBranch(input.task)}-${Date.now()}`;
  await createTaskBranch(projectRoot, branch);

  const projectEntry = input.project ? lookupProjectEntry(input.project, config.projects) : undefined;
  const testCommand = projectEntry?.testCommand ?? (await detectTestCommand(projectRoot));
  const testTimeoutMs = input.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxImplementCycles = clamp(input.maxImplementCycles ?? DEFAULT_MAX_IMPLEMENT_CYCLES, 1, 5);
  const maxReviewCycles = clamp(input.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES, 0, 3);

  const trackedFiles = await listTrackedFiles(projectRoot, MAX_TRACKED_FILES_LISTED);

  let implementAttempts = 0;
  let filesChanged: string[] = [];
  let lastTestResult: { passed: boolean; output: string } | undefined;
  let feedbackForNextAttempt: string | undefined;

  while (implementAttempts < maxImplementCycles) {
    implementAttempts += 1;

    let implementerText: string;
    try {
      implementerText = await callRole(
        config,
        "implementer",
        buildImplementPrompt(input.task, context.text, trackedFiles, feedbackForNextAttempt)
      );
    } catch (error) {
      await checkoutBranchSafely(projectRoot, baseBranch);
      if (error instanceof TaskAgentError) {
        throw error;
      }
      throw new TaskAgentError(`Implementer call failed on attempt ${implementAttempts}: ${describeError(error)}`, 502);
    }

    const changes = parseFileBlocks(implementerText);

    if (changes.length === 0) {
      feedbackForNextAttempt =
        "Your previous response contained no FILE: blocks. Respond using exactly the FILE: <path> format followed by a fenced code block, nothing else will be applied.";
      continue;
    }
    if (changes.length > MAX_FILES_PER_ATTEMPT) {
      feedbackForNextAttempt = `Your previous response touched ${changes.length} files, over the ${MAX_FILES_PER_ATTEMPT} file limit per attempt. Make a smaller, more focused change.`;
      continue;
    }

    let writes: Array<{ absolutePath: string; relativePath: string; content: string }>;
    try {
      writes = validateAndPrepareWrites(projectRoot, changes);
    } catch (error) {
      feedbackForNextAttempt =
        error instanceof FileChangeError
          ? error.message
          : "One or more file paths in your response were rejected for safety reasons, use only project-relative paths.";
      continue;
    }

    for (const write of writes) {
      await mkdir(path.dirname(write.absolutePath), { recursive: true });
      await writeFile(write.absolutePath, write.content, "utf8");
    }
    filesChanged = writes.map((w) => w.relativePath);

    if (!testCommand) {
      lastTestResult = undefined;
      break;
    }

    const testResult = await runTests(projectRoot, testCommand, testTimeoutMs);
    lastTestResult = { passed: testResult.passed, output: testResult.output };

    if (testResult.passed) {
      break;
    }
    if (implementAttempts < maxImplementCycles) {
      feedbackForNextAttempt = `The previous attempt's tests failed.\n\nTest command: ${testCommand}\n\nOutput:\n${testResult.output}\n\nFix the code so the tests pass. Respond again with full FILE: blocks for every file that needs to change.`;
    }
  }

  if (filesChanged.length === 0) {
    await checkoutBranchSafely(projectRoot, baseBranch);
    throw new TaskAgentError(
      "The implementer never produced an applicable file change after all attempts, no branch was left behind.",
      502
    );
  }

  let reviewApproved: boolean | null = null;
  let reviewFeedback: string | undefined;
  let reviewCycles = 0;
  const testsFailedOutright = lastTestResult ? !lastTestResult.passed : false;

  if (config.roles.reviewer && !testsFailedOutright) {
    while (reviewCycles <= maxReviewCycles) {
      let reviewText: string;
      try {
        const diff = await getWorkingDiff(projectRoot);
        reviewText = await callRole(config, "reviewer", buildReviewPrompt(input.task, diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEWER)));
      } catch (error) {
        reviewApproved = null;
        reviewFeedback = `Reviewer call failed, review skipped: ${describeError(error)}`;
        break;
      }

      if (/^\s*APPROVED/i.test(reviewText)) {
        reviewApproved = true;
        break;
      }

      reviewApproved = false;
      reviewFeedback = reviewText.trim();
      reviewCycles += 1;
      if (reviewCycles > maxReviewCycles) {
        break;
      }

      let revisionText: string;
      try {
        revisionText = await callRole(
          config,
          "implementer",
          buildImplementPrompt(
            input.task,
            context.text,
            trackedFiles,
            `A reviewer requested changes:\n\n${reviewFeedback}\n\nAddress this feedback. Respond again with full FILE: blocks for every file that needs to change.`
          )
        );
      } catch (error) {
        reviewFeedback = `${reviewFeedback}\n\n(Follow-up implement call failed: ${describeError(error)}, keeping the pre-revision version.)`;
        break;
      }

      const revisionChanges = parseFileBlocks(revisionText);
      for (const change of revisionChanges) {
        try {
          const absolutePath = resolveSafeFilePath(projectRoot, change.relativePath);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, change.content, "utf8");
          if (!filesChanged.includes(change.relativePath)) {
            filesChanged.push(change.relativePath);
          }
        } catch {
          // An individual unsafe path from a revision is skipped, not fatal to the cycle.
        }
      }

      if (testCommand) {
        const retest = await runTests(projectRoot, testCommand, testTimeoutMs);
        lastTestResult = { passed: retest.passed, output: retest.output };
        if (!retest.passed) {
          break;
        }
      }
    }
  }

  const finalTestsPassed = lastTestResult ? lastTestResult.passed : null;
  const commitMessage = buildCommitMessage(input.task, finalTestsPassed, reviewApproved);
  const commitSha = await commitAll(projectRoot, commitMessage);

  const status = determineStatus(finalTestsPassed, reviewApproved);
  const summary = buildSummary(status, branch, filesChanged, testCommand);

  await logRequest({
    project: input.project ?? null,
    task: input.task,
    role: "implementer",
    taskType: "coding_task",
    modelKey: config.roles.implementer ?? "unknown",
    model: config.models[config.roles.implementer]?.model ?? "unknown",
    provider: config.models[config.roles.implementer]?.provider ?? "unknown",
    costUsd: 0,
    latencyMs: 0,
    success: true,
    attempts: implementAttempts,
  });

  return {
    branch,
    baseBranch,
    project: input.project,
    filesChanged,
    testCommand,
    testsPassed: finalTestsPassed,
    testOutput: lastTestResult?.output,
    reviewApproved,
    reviewFeedback,
    implementAttempts,
    reviewCycles,
    commitSha,
    status,
    summary,
  };
}

function validateAndPrepareWrites(
  projectRoot: string,
  changes: Array<{ relativePath: string; content: string }>
): Array<{ absolutePath: string; relativePath: string; content: string }> {
  let totalBytes = 0;
  return changes.map((change) => {
    totalBytes += Buffer.byteLength(change.content, "utf8");
    if (totalBytes > MAX_TOTAL_CONTENT_BYTES) {
      throw new FileChangeError(`Total content across files exceeds ${MAX_TOTAL_CONTENT_BYTES} bytes for one attempt.`);
    }
    const absolutePath = resolveSafeFilePath(projectRoot, change.relativePath);
    return { absolutePath, relativePath: change.relativePath, content: change.content };
  });
}

async function callRole(config: AppConfig, role: string, prompt: string): Promise<string> {
  const modelKey = config.roles[role];
  if (!modelKey) {
    throw new TaskAgentError(`No model assigned to role "${role}" in config/roles.json.`, 500);
  }
  const model = config.models[modelKey];
  if (!model || model.enabled === false) {
    throw new TaskAgentError(`Role "${role}" points at model "${modelKey}", which is missing or disabled in config/models.json.`, 500);
  }
  const provider = getProvider(model.provider);
  const maxTokens = role === "reviewer" ? REVIEWER_MAX_TOKENS : IMPLEMENTER_MAX_TOKENS;
  const response = await provider.generate({ prompt, maxTokens }, model);
  return response.text;
}

async function checkoutBranchSafely(cwd: string, branch: string): Promise<void> {
  try {
    await checkoutBranch(cwd, branch);
  } catch {
    // Best effort, the caller's own error message is still informative without this.
  }
}

function buildImplementPrompt(task: string, projectContext: string | undefined, trackedFiles: string[], feedback: string | undefined): string {
  const parts: string[] = [
    "You are the implementer for a coding task. You must respond ONLY using this exact format for every file you add or change, nothing else outside the blocks matters:",
    'FILE: relative/path/to/file.ext\n```\n<full file content>\n```',
    "Always write the FULL content of each file, never a partial diff or a snippet. Use paths relative to the project root, never absolute paths.",
    `Task: ${task}`,
  ];
  if (projectContext) {
    parts.push(`Project context:\n\n${projectContext}`);
  }
  if (trackedFiles.length > 0) {
    parts.push(`Files that already exist in this project (for reference, contents not shown):\n${trackedFiles.join("\n")}`);
  }
  if (feedback) {
    parts.push(feedback);
  }
  return parts.join("\n\n");
}

function buildReviewPrompt(task: string, diff: string): string {
  return [
    "You are reviewing a code change made by another model for the task below.",
    `Task: ${task}`,
    `Diff:\n${diff || "(no diff captured)"}`,
    'If the change reasonably accomplishes the task and has no serious problems, respond with exactly "APPROVED" and nothing else.',
    'Otherwise, respond starting with "CHANGES_REQUESTED:" followed by specific, actionable feedback.',
  ].join("\n\n");
}

function buildCommitMessage(task: string, testsPassed: boolean | null, reviewApproved: boolean | null): string {
  const truncatedTask = task.length > 72 ? `${task.slice(0, 72)}...` : task;
  const testNote = testsPassed === null ? "no tests run" : testsPassed ? "tests passing" : "tests failing";
  const reviewNote = reviewApproved === null ? "review skipped" : reviewApproved ? "reviewed" : "review requested changes";
  return `AI: ${truncatedTask}\n\n${testNote}, ${reviewNote}. Generated by Polynym Router, review before merging.`;
}

function determineStatus(testsPassed: boolean | null, reviewApproved: boolean | null): TaskStatus {
  if (testsPassed === false) {
    return "committed_tests_failing";
  }
  if (reviewApproved === false) {
    return "committed_needs_review";
  }
  return "committed_clean";
}

function buildSummary(status: TaskStatus, branch: string, filesChanged: string[], testCommand: string | undefined): string {
  const fileNote = `${filesChanged.length} file(s) changed on branch "${branch}"`;
  if (status === "committed_clean") {
    return `${fileNote}. Tests ${testCommand ? "passed" : "were not run, no test command found"} and the reviewer approved. Ready for you to inspect and merge.`;
  }
  if (status === "committed_tests_failing") {
    return `${fileNote}. Tests are still failing after all implement attempts. Committed as-is for you to pick up manually, check the branch.`;
  }
  return `${fileNote}. Tests passed but the reviewer requested changes that were not fully resolved. Committed for your manual review.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

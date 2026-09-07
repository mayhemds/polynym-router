import path from "node:path";

export interface FileChange {
  relativePath: string;
  content: string;
}

const FILE_BLOCK_PATTERN = /FILE:\s*(\S+)\s*\r?\n```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/g;

export class FileChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChangeError";
  }
}

/**
 * Extracts every `FILE: <path>` + fenced code block pair from a model's
 * response. Anything outside those blocks (reasoning, prose) is ignored on
 * purpose, the model is free to explain itself, only the blocks matter.
 */
export function parseFileBlocks(text: string): FileChange[] {
  const matches: FileChange[] = [];
  for (const match of text.matchAll(FILE_BLOCK_PATTERN)) {
    const relativePath = match[1]?.trim();
    const content = match[2] ?? "";
    if (relativePath) {
      matches.push({ relativePath, content });
    }
  }
  return matches;
}

/**
 * Resolves a model-provided relative path against the project root and
 * refuses anything that escapes it, targets an absolute path, or touches
 * .git directly. This is the write-side equivalent of the read-side
 * allowlist check in projects/context.ts, both exist because paths here
 * come from model output, not from the operator.
 */
export function resolveSafeFilePath(projectRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new FileChangeError(`Refusing to write to absolute path "${relativePath}", only project-relative paths are allowed.`);
  }

  const segments = relativePath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new FileChangeError(`Refusing to write to "${relativePath}", path traversal segments are not allowed.`);
  }
  if (segments[0] === ".git") {
    throw new FileChangeError(`Refusing to write to "${relativePath}", the .git directory is off limits.`);
  }

  const resolved = path.resolve(projectRoot, relativePath);
  const normalizedRoot = path.resolve(projectRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new FileChangeError(`Resolved path "${resolved}" escapes the project root, refusing to write it.`);
  }

  return resolved;
}

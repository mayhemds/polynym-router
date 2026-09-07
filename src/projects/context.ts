import { readFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectsMap } from "../types.js";
import { lookupProjectEntry } from "./registry.js";

// Read whichever of these exist, skip whichever don't. Nothing here assumes
// a particular language or framework, it is plain markdown either way.
const CONTEXT_FILES = [
  "project.md",
  "architecture.md",
  "conventions.md",
  "decisions.md",
  "database.md",
  "rules.md",
  "tasks.md",
];

// Marker files used only to label the detected stack for visibility in the
// response. Detection failing or finding nothing never blocks a request.
const STACK_MARKERS: Record<string, string> = {
  "package.json": "Node/TypeScript/JavaScript",
  "go.mod": "Go",
  "Cargo.toml": "Rust",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  Gemfile: "Ruby",
  "pom.xml": "Java (Maven)",
  "build.gradle": "Java/Kotlin (Gradle)",
  "composer.json": "PHP",
  "mix.exs": "Elixir",
  "CMakeLists.txt": "C/C++",
  "go.sum": "Go",
};

const MAX_CONTEXT_CHARS = 12000;

export interface ProjectContext {
  text?: string;
  detectedStack: string[];
  resolvedPath?: string;
  truncated: boolean;
}

/**
 * Confirms `candidate` is inside one of `allowedRoots`, using a path
 * separator boundary check rather than a plain string prefix match, so a
 * sibling directory that happens to share a prefix (`/projects` vs
 * `/projects-evil`) is correctly rejected.
 */
export function isWithinAllowedRoots(candidate: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) {
    return false;
  }
  const normalizedCandidate = path.resolve(candidate);
  return allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
  });
}

export async function loadProjectContext(
  project: string | undefined,
  projectPath: string | undefined,
  projects: ProjectsMap,
  allowedRoots: string[]
): Promise<ProjectContext> {
  const resolvedPath = resolveProjectPath(project, projectPath, projects, allowedRoots);
  if (!resolvedPath) {
    return { detectedStack: [], truncated: false };
  }

  const detectedStack = await detectStack(resolvedPath);
  const aiDir = path.join(resolvedPath, ".ai");

  const sections: string[] = [];
  for (const file of CONTEXT_FILES) {
    const filePath = path.join(aiDir, file);
    try {
      await access(filePath);
      const content = await readFile(filePath, "utf8");
      if (content.trim().length > 0) {
        sections.push(`## ${file}\n\n${content.trim()}`);
      }
    } catch {
      // This context file does not exist for this project, that is normal.
    }
  }

  if (sections.length === 0) {
    return { detectedStack, resolvedPath, truncated: false };
  }

  let combined = sections.join("\n\n---\n\n");
  let truncated = false;
  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = `${combined.slice(0, MAX_CONTEXT_CHARS)}\n\n[context truncated at ${MAX_CONTEXT_CHARS} characters]`;
    truncated = true;
  }

  return { text: combined, detectedStack, resolvedPath, truncated };
}

function resolveProjectPath(
  project: string | undefined,
  projectPath: string | undefined,
  projects: ProjectsMap,
  allowedRoots: string[]
): string | undefined {
  const candidate = computeCandidatePath(project, projectPath, projects);
  if (candidate === undefined) {
    return undefined;
  }

  if (!isWithinAllowedRoots(candidate, allowedRoots)) {
    throw new Error(
      `Resolved project path "${candidate}" is outside the allowed roots. Set ALLOWED_PROJECT_ROOTS in .env to permit it.`
    );
  }

  return candidate;
}

function computeCandidatePath(
  project: string | undefined,
  projectPath: string | undefined,
  projects: ProjectsMap
): string | undefined {
  if (projectPath) {
    return path.resolve(process.cwd(), projectPath);
  }
  const entry = project ? lookupProjectEntry(project, projects) : undefined;
  if (entry) {
    return path.resolve(process.cwd(), entry.path);
  }
  return undefined;
}

async function detectStack(rootPath: string): Promise<string[]> {
  const detected = new Set<string>();
  try {
    const entries = await readdir(rootPath);
    for (const entry of entries) {
      const label = STACK_MARKERS[entry];
      if (label) {
        detected.add(label);
      }
      if (entry.endsWith(".csproj") || entry.endsWith(".sln")) {
        detected.add("C#/.NET");
      }
    }
  } catch {
    // Directory unreadable or missing, report no detected stack rather than
    // failing the whole request over a cosmetic detail.
  }
  return Array.from(detected);
}

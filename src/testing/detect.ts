import { access } from "node:fs/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";

interface DetectionRule {
  marker: string;
  command: string;
  /** Only used for package.json, where we additionally check for a "test" script. */
  requiresPackageJsonTestScript?: boolean;
}

// Ordered by specificity. These are reasonable per-language defaults, not
// guarantees, that is exactly why an explicit testCommand in
// config/projects.json always overrides this.
const RULES: DetectionRule[] = [
  { marker: "package.json", command: "npm test", requiresPackageJsonTestScript: true },
  { marker: "pyproject.toml", command: "pytest -q" },
  { marker: "requirements.txt", command: "pytest -q" },
  { marker: "go.mod", command: "go test ./..." },
  { marker: "Cargo.toml", command: "cargo test" },
  { marker: "Gemfile", command: "bundle exec rspec" },
  { marker: "pom.xml", command: "mvn -q test" },
  { marker: "build.gradle", command: "gradle test" },
  { marker: "composer.json", command: "composer test" },
];

/**
 * Returns undefined if nothing recognizable was found. Callers must treat
 * "no test command" as "skip testing, not an error", never assume a
 * command exists.
 */
export async function detectTestCommand(rootPath: string): Promise<string | undefined> {
  for (const rule of RULES) {
    const markerPath = path.join(rootPath, rule.marker);
    const exists = await fileExists(markerPath);
    if (!exists) continue;

    if (rule.requiresPackageJsonTestScript) {
      const hasTestScript = await packageJsonHasTestScript(markerPath);
      if (!hasTestScript) continue;
    }

    return rule.command;
  }
  return undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function packageJsonHasTestScript(packageJsonPath: string): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const testScript = parsed.scripts?.test;
    // npm's default placeholder script, treat as "no real test command".
    return Boolean(testScript && !testScript.includes("no test specified"));
  } catch {
    return false;
  }
}

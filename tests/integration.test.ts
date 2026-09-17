import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

// A mock Ollama-shaped HTTP server so the full routing + coding-agent
// pipeline can be exercised against a controllable provider, with no real
// API keys or network access required.

let mockServer: http.Server;
let mockUrl: string;

let configDir: string;
let dataDir: string;
let scratchRepo: string;

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function startMockServer(): Promise<string> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        const lastMessage = Array.isArray(parsed.messages)
          ? (parsed.messages[parsed.messages.length - 1]?.content ?? "")
          : "";

        let content: string;
        if (typeof lastMessage === "string" && lastMessage.includes("implementer for a coding task")) {
          content = 'FILE: math.py\n```\ndef add(a, b):\n    return a + b\n\ndef subtract(a, b):\n    return a - b\n```';
        } else if (typeof lastMessage === "string" && lastMessage.includes("You are reviewing a code change")) {
          content = "APPROVED";
        } else {
          content = "mocked response";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: { content },
            prompt_eval_count: 3,
            eval_count: 4,
          })
        );
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      const address = mockServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function writeMockConfig(dir: string, baseUrl: string): void {
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      mock: {
        provider: "ollama",
        model: "mock-model",
        baseUrl,
        capabilities: ["coding", "implementation", "classification"],
        contextWindow: 128000,
        tier: "local",
        pricePerMInputUsd: 0,
        pricePerMOutputUsd: 0,
        enabled: true,
      },
    })
  );
  writeFileSync(path.join(dir, "roles.json"), JSON.stringify({ implementer: "mock", reviewer: "mock" }));
  writeFileSync(
    path.join(dir, "rules.json"),
    JSON.stringify([{ taskType: "coding", role: "implementer", keywords: ["implement", "add", "build", "fix"] }])
  );
  writeFileSync(path.join(dir, "projects.json"), JSON.stringify({}));
}

before(async () => {
  mockUrl = await startMockServer();

  configDir = await mkdtemp(path.join(tmpdir(), "pr-config-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "pr-data-"));
  writeMockConfig(configDir, mockUrl);

  scratchRepo = await mkdtemp(path.join(tmpdir(), "pr-repo-"));
  run(scratchRepo, ["init", "-q"]);
  run(scratchRepo, ["config", "user.email", "test@test.com"]);
  run(scratchRepo, ["config", "user.name", "test"]);
  writeFileSync(path.join(scratchRepo, "math.py"), "def add(a, b):\n    return a + b\n");
  writeFileSync(path.join(scratchRepo, "test_math.py"), "def test_add():\n    assert add(1, 2) == 3\n");
  run(scratchRepo, ["add", "-A"]);
  run(scratchRepo, ["commit", "-qm", "init"]);

  // config.ts and telemetry/log.ts resolve their directories at call time,
  // so setting these before the dynamic imports below is sufficient.
  process.env.CONFIG_DIR = configDir;
  process.env.DATA_DIR = dataDir;
  process.env.ALLOWED_PROJECT_ROOTS = scratchRepo;
});

after(async () => {
  mockServer.close();
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratchRepo, { recursive: true, force: true });
  delete process.env.CONFIG_DIR;
  delete process.env.DATA_DIR;
  delete process.env.ALLOWED_PROJECT_ROOTS;
});

const { routeRequest } = await import("../src/router/route.js");
const { runCodingTask } = await import("../src/agent/taskAgent.js");
const { readStats } = await import("../src/telemetry/log.js");

test("routeRequest classifies, routes to the mock provider, and returns a response", async () => {
  const result = await routeRequest({ task: "implement a login form" });

  assert.equal(result.model, "mock-model");
  assert.equal(result.provider, "ollama");
  assert.equal(result.taskType, "coding");
  assert.equal(result.role, "implementer");
  assert.equal(result.response, "mocked response");
  assert.equal(result.costUsd, 0);
});

test("runCodingTask branches, writes files, reviews, and commits without touching the base branch", async () => {
  const result = await runCodingTask({
    task: "Add a subtract function to math.py",
    projectPath: scratchRepo,
    maxReviewCycles: 1,
  });

  assert.equal(result.baseBranch, "master");
  assert.notEqual(result.branch, "master");
  assert.deepEqual(result.filesChanged.sort(), ["math.py"]);
  assert.equal(result.reviewApproved, true);
  assert.equal(result.status, "committed_clean");
  assert.ok(result.commitSha.length > 0);

  // The change landed on the task branch.
  const branchMath = await readFile(path.join(scratchRepo, "math.py"), "utf8");
  assert.match(branchMath, /subtract/);

  // Base branch is untouched.
  run(scratchRepo, ["checkout", "-q", "master"]);
  const baseMath = await readFile(path.join(scratchRepo, "math.py"), "utf8");
  assert.doesNotMatch(baseMath, /subtract/);
  run(scratchRepo, ["checkout", "-q", result.branch]);
});

test("coding-task telemetry is recorded against the real outcome", async () => {
  const stats = await readStats();
  const mock = stats.byModel.mock;
  assert.ok(mock, "expected telemetry for the mock model");
  assert.ok(mock.requests >= 1);
});

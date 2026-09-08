# Polynym Router

A single HTTP endpoint your projects call instead of calling Claude, GPT, Kimi, or a local model directly. It reads a task description, works out what kind of work it is, and picks the best currently-configured model for the job. Your projects never hardcode a model name.

**New here?** See `GETTING_STARTED.md` for a linear setup-to-first-use walkthrough. This document is the full reference.

It covers the core router, provider adapters, project context loading, task classification, role-based routing, request logging, git branch-per-task coding with test running and review, an MCP server, and adaptive routing from historical performance.

## Why this design

**Any language, any project.** The router does not need to know what your project is written in. It reads a `.ai/` folder of plain markdown files sitting in the project's repo, `.ai/project.md`, `.ai/architecture.md`, and so on, whichever exist. Nothing about that format is TypeScript-specific. `examples/sample-project` is a Python/FastAPI project, deliberately not a TypeScript one, to prove the point. On top of that, the router does light auto-detection of the project's stack by checking for marker files (`go.mod`, `pyproject.toml`, `Cargo.toml`, `Gemfile`, and so on) purely for visibility in the response, it never gates on this.

**Future-proof against model churn.** Nothing about which model fills which role is hardcoded in TypeScript. `config/models.json` is the entire model registry, edited as plain JSON. `config/roles.json` maps abstract roles (`implementer`, `architect`, `reviewer`, `researcher`, `cheap_worker`) to whichever model key currently fills them. When a new model comes out and changes the hierarchy, you edit two JSON files, you do not touch a single `.ts` file or redeploy your other projects. Adding a brand-new provider is usually also just a JSON entry: most providers, including Kimi/Moonshot, speak the same OpenAI-compatible chat completions format, so `config/models.json` just points at their base URL. A genuinely new wire format needs one new adapter file implementing a five-line interface, see "Adding a new provider" below.

## Project layout

```
polynym-router/
├── config/
│   ├── models.json      # the model registry, edit this when models change
│   ├── roles.json        # role -> model key
│   ├── rules.json        # keyword -> task type / role, used by the classifier
│   └── projects.json     # project name -> path, optional, you can also pass a full path per request
├── src/
│   ├── server.ts          # Express entry point (HTTP: /v1/ai, /v1/tasks, /v1/stats)
│   ├── config.ts          # loads + validates the JSON config files
│   ├── types.ts
│   ├── providers/         # one adapter per wire format, not per model
│   ├── router/            # classifier, scorer, orchestrator for /v1/ai
│   ├── agent/             # coding agent orchestrator + file-block parser for /v1/tasks
│   ├── git/               # git CLI wrapper, branch-per-task safety model
│   ├── testing/           # test command auto-detection + execution
│   ├── projects/          # .ai/ context loader + project registry
│   ├── telemetry/         # request log
│   ├── routes/            # HTTP handlers
│   └── mcp/               # MCP stdio server, wraps the same router/agent logic
├── examples/sample-project/  # a Python project with a .ai/ folder, for testing
├── public/dashboard.html      # self-contained stats dashboard, no build step
├── GETTING_STARTED.md         # linear setup walkthrough, start here if you're new
└── tests/
```

## Setup

Requires Node 18.17+ (works with Bun too if you prefer, the code has no Bun-specific APIs).

```bash
cd polynym-router
npm install
cp .env.example .env
```

Edit `.env` and fill in API keys only for the providers you actually use, matching the `apiKeyEnv` names referenced in `config/models.json`:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
KIMI_API_KEY=...
```

If you plan to route anything to Ollama, make sure it's running locally (`ollama serve`) and the model is pulled (`ollama pull llama3.1:8b` or whatever you set in `config/models.json`).

Run it:

```bash
npm run dev
```

## Using it

```bash
curl -X POST http://localhost:3000/v1/ai \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Implement retry handling for the invoice parser",
    "project": "sample-project"
  }'
```

Response:

```json
{
  "model": "kimi-k2",
  "provider": "openai_compatible",
  "role": "implementer",
  "taskType": "coding",
  "reason": "Matched keywords [implement] to role \"implementer\", selected \"kimi_k2\" as the top-scoring enabled model.",
  "response": "...",
  "costUsd": 0.0031,
  "latencyMs": 1840,
  "attempts": 1,
  "detectedStack": ["Python"],
  "contextTruncated": false
}
```

`project` looks the project up in `config/projects.json`. You can skip that file entirely and pass `projectPath` directly instead, an absolute or relative path to any project's root, which is what makes this usable across every project on your machine without maintaining a central list:

```json
{ "task": "...", "projectPath": "/home/you/code/some-other-project" }
```

For visibility into what's happened over time:

```bash
curl http://localhost:3000/v1/stats
```

## Adding a new model

Edit `config/models.json`, no code change:

```json
"new_model_key": {
  "provider": "openai_compatible",
  "model": "whatever-the-provider-calls-it",
  "baseUrl": "https://api.provider.com/v1",
  "apiKeyEnv": "NEW_PROVIDER_API_KEY",
  "capabilities": ["coding", "reasoning"],
  "contextWindow": 200000,
  "tier": "frontier",
  "pricePerMInputUsd": 3,
  "pricePerMOutputUsd": 12,
  "enabled": true
}
```

Add the matching `NEW_PROVIDER_API_KEY` to `.env`. Optionally point a role at it in `config/roles.json`. That's the whole change.

## Adding a new provider (new wire format)

Only needed if the provider doesn't speak the OpenAI chat completions format or Anthropic's format. Implement `AIProvider` from `src/types.ts`:

```ts
export interface AIProvider {
  generate(request: AIRequest, model: ModelConfig): Promise<AIResponse>;
}
```

Drop the file in `src/providers/`, register it in `src/providers/index.ts` under a new key, then use that key as the `"provider"` value in `config/models.json`. The router, classifier, and scorer never change.

## Adaptive routing from history

The scorer in `src/router/scorer.ts` factors in each model's actual track record, not just declared capabilities and pricing.

**How it works**: every request is logged with a success/failure flag. Once a specific model key has **5 or more** logged requests, its success rate starts adjusting its score: a perfect record adds up to +15, a consistently poor one subtracts up to 15, scaled linearly around a 50% midpoint. Below 5 requests for that model, the adjustment is exactly zero, current behavior is unaffected.

This is one success rate per model overall, not broken down per task type or role, so a model that's excellent at `architecture` tasks but mediocre at `coding` ones won't be distinguished yet.

Check the dashboard (`/dashboard`) to see which models have crossed the 5-request threshold, that's the "Adaptive routing" column.

## Dashboard

```
http://localhost:3000/dashboard
```

A single self-contained HTML page (`public/dashboard.html`, no build step, no dependencies) showing total requests, success rate, total cost, and a per-model breakdown, refreshing every 15 seconds. It reads from the same `GET /v1/stats` endpoint everything else uses, this is just a friendlier view of the same data. All data stays local, the page only ever calls back to the router serving it.

## The coding agent (`POST /v1/tasks`)

This is a different, higher-stakes endpoint from `/v1/ai`. Where `/v1/ai` just returns text, `/v1/tasks` actually branches, writes files, runs your tests, and commits, on your own filesystem. Read this section before pointing it at a real project.

### What it does, step by step

1. Confirms the project is a git repo with a clean working tree. Refuses otherwise, on purpose, see Safety model below.
2. Creates a new branch, `ai/task-<slug>-<timestamp>`, off whatever branch you were on. Never touches your original branch.
3. Works out the test command: an explicit `testCommand` in `config/projects.json` always wins, otherwise it's auto-detected from marker files (`package.json` test script, `pyproject.toml`/`requirements.txt` → `pytest -q`, `go.mod` → `go test ./...`, `Cargo.toml` → `cargo test`, and a few more). No test command found just means testing is skipped, it never guesses and never blocks on a guess.
4. The `implementer` role model writes changes, formatted as `FILE: <path>` blocks with full file content, which get applied directly to disk. Every path is checked against the project root before anything is written, see Safety model.
5. If a test command exists, it runs. On failure, the test output goes back to the implementer for up to `maxImplementCycles` (default 2) attempts.
6. If a `reviewer` role is configured and tests didn't fail outright, the reviewer sees the diff and either approves or requests changes, up to `maxReviewCycles` (default 1) revision rounds.
7. Everything gets committed once, on the task branch, with a message stating whether tests passed and whether it was reviewed. **Nothing is ever pushed, and nothing is ever merged automatically.** That's on you.

### Example

```bash
curl -X POST http://localhost:3000/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Add retry handling with exponential backoff to the invoice parser",
    "project": "sample-project"
  }'
```

```json
{
  "branch": "ai/task-add-retry-handling-1234567890",
  "baseBranch": "main",
  "filesChanged": ["core/retry_wrapper.py", "core/parser_service.py"],
  "testCommand": "pytest -q",
  "testsPassed": true,
  "reviewApproved": true,
  "implementAttempts": 1,
  "reviewCycles": 0,
  "commitSha": "a1b2c3d...",
  "status": "committed_clean",
  "summary": "2 file(s) changed on branch \"ai/task-add-retry-handling-1234567890\". Tests passed and the reviewer approved. Ready for you to inspect and merge."
}
```

`status` is one of `committed_clean` (tests passed, reviewer approved or no reviewer configured), `committed_needs_review` (tests passed, reviewer never approved within the cycle budget), or `committed_tests_failing` (still broken after all attempts). All three still leave a real commit on the branch, nothing is silently discarded, so you can always `git log` and `git diff` to see exactly what happened.

### Overriding the test command per project

`config/projects.json` entries can now be either a bare path (auto-detect the test command) or an object:

```json
{
  "sample-project": "./examples/sample-project",
  "propertyscribe": {
    "path": "/home/you/code/propertyscribe",
    "testCommand": "npm run test:ci"
  }
}
```

### Safety model

- **Refuses to run on a non-git project.** Branch-per-task is the whole safety story here, without git there's no undo.
- **Refuses to run on a dirty working tree**, so it never mixes its own edits with your in-progress work. Commit or stash first.
- **Never touches your original branch.** Every task gets its own branch, always.
- **Never auto-merges, auto-pushes, or opens a PR.** You review and merge yourself.
- **Every file path from the model is validated** before anything is written: no absolute paths, no `..` traversal, no writing into `.git/`. This is the same class of check used on the read side for `.ai/` context loading, applied to writes.
- **Bounded attempts.** At most `maxImplementCycles` implement attempts and `maxReviewCycles` review rounds, it will not loop forever, it commits whatever it has and tells you honestly what state it's in.
- **It executes your test command as a real shell command.** Only point this at projects whose test scripts you trust, the same way you'd trust running `npm test` yourself.


## Security notes

- This has no built-in authentication. It's meant to run on localhost or behind your own auth layer, don't expose it to the public internet as-is.
- `projectPath` is checked against `ALLOWED_PROJECT_ROOTS` in `.env` before any file is read, to stop a request from pointing outside the directories you intend to expose. Defaults to the current working directory if unset.
- API keys are read from environment variables only, never written to `config/models.json` or logged.
- `data/requests.jsonl` stores a truncated copy of each task description locally, for the telemetry described above. It's in `.gitignore`. If your tasks routinely contain sensitive material, keep that in mind before sharing the `data/` folder.

## MCP server

This exposes the router directly to MCP-compatible tools, Claude Code, Cursor, or anything else that can spawn a local MCP server over stdio, without needing the HTTP server running separately. It imports `routeRequest` and `runCodingTask` directly, same logic as `/v1/ai` and `/v1/tasks`, just a different transport.

Three tools are exposed:

- **`route_task`**: same as `POST /v1/ai`, classification + routing + a text response. Use for questions, architecture discussion, research, review commentary.
- **`run_coding_task`**: same as `POST /v1/tasks`, the full branch/implement/test/review/commit loop. Same safety model applies: git repo required, clean working tree required, never touches the original branch, never auto-merges.
- **`get_router_stats`**: same as `GET /v1/stats`.

### Running it

```bash
npm run mcp
```

This starts the server on stdio and waits for a client to connect. It won't print anything if working correctly, that's normal for stdio transport.

### Connecting Claude Code

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "polynym-router": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/polynym-router"
    }
  }
}
```

### Connecting Cursor

Same shape, in Cursor's MCP settings:

```json
{
  "mcpServers": {
    "polynym-router": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/absolute/path/to/polynym-router"
    }
  }
}
```

Run `npm run build` first if using the compiled `dist/` path, or use the `npm run mcp` form like the Claude Code example above to run it straight from source.

### Testing it standalone

Before wiring it into an editor, check the tools list and try a call with the official inspector:

```bash
npx @modelcontextprotocol/inspector npm run mcp
```

That opens a local UI where you can call `route_task`, `run_coding_task`, or `get_router_stats` directly and see the raw response, useful for confirming the server itself works before trusting an editor's integration of it.

## Tests

```bash
npm test
```

Covers the classifier, the scorer including the historical-bonus threshold logic, the path-traversal guard on project context loading, and the file-block parser plus write-path safety guard used by `/v1/tasks`. It does not hit any real provider APIs and does not touch git or the filesystem outside `/tmp` paths used in assertions. The MCP server has no dedicated unit tests of its own, since it's a thin transport wrapper around already-tested logic, use the inspector command above to exercise it directly.

## License

MIT, see `LICENSE`. Use it, fork it, change it.

## Contributing

Issues and pull requests are welcome. If you're reporting a bug, include the exact request you sent and the exact response or error you got back, the error messages in this project are written to be specific, so they're usually the fastest way to diagnose what went wrong.

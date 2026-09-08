# Getting Started with Polynym Router

This is the walkthrough version. If you want the full reference (every config option, every safety detail), see `README.md`. This document just gets you from "downloaded the zip" to "actually using it," in order.

## What this actually is

A small service that sits between you and AI models. Instead of your projects calling Claude, GPT, or Kimi directly, they call this router with a plain description of a task. The router figures out what kind of task it is, picks whichever model is currently best suited and available, and returns the result. When a better model comes out next year, you edit a JSON file, not every project that uses it.

It does three different things, at three different levels of risk:

- **Answers questions** (`/v1/ai`): "explain this architecture," "review this approach." Just returns text, changes nothing.
- **Writes code** (`/v1/tasks`): creates a git branch, has a model write files, runs your tests, has a second model review it, commits once. Never touches your main branch, never pushes, never merges on its own.
- **Talks to your editor** (MCP server): exposes both of the above to Claude Code, Cursor, or anything else that speaks MCP.

There's also a small dashboard for seeing what it's actually been doing.

## 1. Install it

Requires Node 18.17 or newer.

```bash
cd polynym-router
npm install
cp .env.example .env
```

You don't need to fill in any API keys yet, the first test below uses a free local model instead.

## 2. Prove it works, for free, before spending anything

If you don't already have [Ollama](https://ollama.com) installed, install it, then pull a small model:

```bash
ollama pull llama3.1:8b
```

(Or use whatever model you already have, `ollama list` shows you. If it's a different one, edit `config/models.json` and change the `"model"` field under `"local_small"` to match.)

Start the router:

```bash
npm run dev
```

You should see `Polynym Router listening on port 3000`. In a **second terminal window**, send a test request:

```bash
curl -X POST http://localhost:3000/v1/ai \
  -H "Content-Type: application/json" \
  -d '{"task": "summarise this project", "project": "sample-project", "costSensitive": true}'
```

You should get back a real response describing the included Python sample project, at `"costUsd":0`. If this works, the whole pipeline, classification, project context loading, provider calls, is confirmed working on your machine.

If it doesn't work, the error message will tell you exactly which model failed and why, usually a missing API key or an Ollama model name mismatch, both are one-line fixes.

## 3. Add your real models

Edit `.env` and add whichever keys you actually plan to use:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
KIMI_API_KEY=...
```

You don't need all three. Anything without a key just won't be reachable, and the router will skip it and try the next-best candidate automatically.

Restart `npm run dev` after editing `.env`.

## 4. Point it at a real project

Two ways, use whichever fits:

**Register it by name** in `config/projects.json`:
```json
{
  "sample-project": "./examples/sample-project",
  "my-real-project": "/home/you/code/my-real-project"
}
```
Then reference it as `"project": "my-real-project"` in requests.

**Or just pass the path directly**, no registration needed:
```json
{"task": "...", "projectPath": "/home/you/code/my-real-project"}
```

Either way, if you want it to use project-specific context, create a `.ai/` folder in that project with any of: `project.md`, `architecture.md`, `conventions.md`, `decisions.md`, `database.md`, `rules.md`, `tasks.md`. Plain markdown, whatever's useful. This works identically regardless of what language the project is written in.

**One setting that matters if your project lives outside this folder**: `ALLOWED_PROJECT_ROOTS` in `.env` needs to include the parent directory of any project you point `projectPath` at, or the request gets rejected as a safety measure. Example: `ALLOWED_PROJECT_ROOTS=/home/you/code`.

At this point you can send real questions about a real project through `/v1/ai` and get grounded answers back.

## 5. Try the coding agent, carefully

This is the part that writes files and runs shell commands, so the first time, use a throwaway git repo, not something you care about.

**Requirements before you call it:**
- The target project must be a git repository (`git init` if it isn't).
- Its working tree must be clean (`git status` shows nothing pending), commit or stash first.

```bash
curl -X POST http://localhost:3000/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"task": "Add a health check endpoint", "projectPath": "/path/to/your/scratch/repo"}'
```

It creates a branch named `ai/task-...`, writes code, runs your tests if it can figure out the command (or you can set one explicitly, see the README), has a reviewer model check the diff, and commits once. Your original branch is never touched, nothing is ever pushed or merged automatically, that part is always on you.

Read the response's `status` field: `committed_clean` means tests passed and it was reviewed, `committed_tests_failing` or `committed_needs_review` mean it's still committed but needs your attention, check that branch before trusting it.

## 6. Look at the dashboard

Once you've sent a few requests:

```
http://localhost:3000/dashboard
```

Shows total requests, success rate, cost, and a per-model breakdown, along with which models have logged enough requests (5+) for their track record to start influencing future routing decisions automatically. It refreshes itself every 15 seconds while open. All the data comes from `data/requests.jsonl` on your own machine, nothing is sent anywhere else.

## 7. Wire it into your editor (optional)

If you use Claude Code or Cursor, you can skip the HTTP layer entirely and let your editor call the router directly.

```bash
npx @modelcontextprotocol/inspector npm run mcp
```

opens a local UI to test the connection first. Once that works, add the config shown in the README's "MCP server" section to Claude Code or Cursor's MCP settings, and both `route_task` and `run_coding_task` become tools your editor can call on its own.

## What happens automatically over time

Nothing you need to do, but worth knowing: every request, successful or not, gets logged. Once any model has 5 or more logged requests, its actual success rate starts nudging future routing decisions, a model that's been reliable for you gets a small edge, one that keeps failing gets a small penalty. Below 5 requests it has zero effect, so this stays out of your way until there's enough real signal to trust. Check the dashboard's "Adaptive routing" column to see which models have crossed that line.

## If something breaks

The error messages in this project are written to be specific, wrong API key names, exact file paths that failed, which model was tried and why it didn't work. Read the message first, it usually says exactly what's wrong. If it genuinely looks like a bug rather than a config issue, that's worth reporting with the exact request and response.

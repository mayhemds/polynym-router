import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { routeRequest, RoutingError } from "../router/route.js";
import type { RouteRequestInput } from "../router/route.js";
import { runCodingTask, TaskAgentError } from "../agent/taskAgent.js";
import type { TaskAgentInput } from "../agent/taskAgent.js";
import { readStats } from "../telemetry/log.js";

const server = new McpServer({ name: "polynym-router", version: "0.1.0" });

server.registerTool(
  "route_task",
  {
    title: "Route an AI task",
    description:
      'Classifies a task, picks the best currently-configured model for it, and returns its response as text. Use this for questions, architecture discussion, code review commentary, or research, anything that should return an answer rather than edit files. For file-editing coding work, use run_coding_task instead. Optionally scope it to a project so it can load that project\'s .ai/ context.',
    inputSchema: {
      task: z.string().min(1).max(20000).describe("The task or question to route."),
      project: z.string().min(1).max(200).optional().describe("A project name registered in config/projects.json."),
      projectPath: z
        .string()
        .min(1)
        .max(1000)
        .optional()
        .describe('Absolute or relative path to a project, used instead of "project".'),
      role: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Force a specific role (e.g. "architect", "researcher") instead of letting the classifier pick one.'),
      costSensitive: z.boolean().optional().describe("Prefer cheaper or local models when true."),
      maxTokens: z.number().int().positive().max(64000).optional(),
    },
  },
  async (input: RouteRequestInput) => {
    try {
      const result = await routeRequest(input);
      const header = `[${result.provider}/${result.model} as ${result.role}, $${result.costUsd}]`;
      return {
        content: [{ type: "text", text: `${header}\n\n${result.response}` }],
      };
    } catch (error) {
      const message = error instanceof RoutingError ? error.message : describeError(error);
      return { content: [{ type: "text", text: `Routing failed: ${message}` }], isError: true };
    }
  }
);

server.registerTool(
  "run_coding_task",
  {
    title: "Run an autonomous coding task",
    description:
      "Creates a new git branch in the target project, has the implementer model write file changes for the given task, runs the project's tests, optionally has a reviewer model check the diff, then commits everything once to that branch. Never touches the project's original branch, never pushes, never merges. Requires the project to be a git repository with a clean working tree, it refuses otherwise. This can take several minutes and executes the project's real test command as a shell command.",
    inputSchema: {
      task: z.string().min(1).max(20000).describe("The coding task to implement."),
      project: z.string().min(1).max(200).optional().describe("A project name registered in config/projects.json."),
      projectPath: z
        .string()
        .min(1)
        .max(1000)
        .optional()
        .describe('Absolute path to the project root, used instead of "project".'),
      maxImplementCycles: z.number().int().min(1).max(5).optional(),
      maxReviewCycles: z.number().int().min(0).max(3).optional(),
      testTimeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
    },
  },
  async (input: TaskAgentInput) => {
    try {
      const result = await runCodingTask(input);
      return {
        content: [{ type: "text", text: `${result.summary}\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof TaskAgentError ? error.message : describeError(error);
      return { content: [{ type: "text", text: `Coding task failed: ${message}` }], isError: true };
    }
  }
);

server.registerTool(
  "get_router_stats",
  {
    title: "Get router usage stats",
    description:
      "Returns aggregate stats from the router's local telemetry log: total requests, success rate, total cost, and a per-model breakdown.",
    inputSchema: {},
  },
  async () => {
    try {
      const stats = await readStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed to read stats: ${describeError(error)}` }], isError: true };
    }
  }
);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  // Fail fast on a broken config, same as the HTTP server does.
  loadConfig();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Polynym Router MCP server failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});

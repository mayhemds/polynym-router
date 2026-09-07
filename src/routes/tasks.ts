import { Router } from "express";
import { z } from "zod";
import { runCodingTask, TaskAgentError } from "../agent/taskAgent.js";

export const tasksRouter = Router();

const taskRequestSchema = z.object({
  task: z.string().min(1, "task is required").max(20000, "task is too long"),
  project: z.string().min(1).max(200).optional(),
  projectPath: z.string().min(1).max(1000).optional(),
  maxImplementCycles: z.number().int().min(1).max(5).optional(),
  maxReviewCycles: z.number().int().min(0).max(3).optional(),
  testTimeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
});

tasksRouter.post("/v1/tasks", async (req, res) => {
  const parsed = taskRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const result = await runCodingTask(parsed.data);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof TaskAgentError) {
      console.error("Coding task failed:", error.message);
      res.status(error.statusHint).json({ error: error.message });
      return;
    }
    console.error("Unexpected coding task error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Internal server error" });
  }
});

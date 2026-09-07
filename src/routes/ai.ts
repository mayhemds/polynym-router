import { Router } from "express";
import { z } from "zod";
import { routeRequest, RoutingError } from "../router/route.js";
import { readStats } from "../telemetry/log.js";

export const aiRouter = Router();

const requestSchema = z.object({
  task: z.string().min(1, "task is required").max(20000, "task is too long"),
  project: z.string().min(1).max(200).optional(),
  projectPath: z.string().min(1).max(1000).optional(),
  role: z.string().min(1).max(100).optional(),
  costSensitive: z.boolean().optional(),
  maxTokens: z.number().int().positive().max(64000).optional(),
});

aiRouter.post("/v1/ai", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const result = await routeRequest(parsed.data);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof RoutingError) {
      console.error("Routing failed:", error.message);
      res.status(error.statusHint).json({ error: error.message });
      return;
    }
    console.error("Unexpected routing error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Internal server error" });
  }
});

aiRouter.get("/v1/stats", async (_req, res) => {
  const stats = await readStats();
  res.status(200).json(stats);
});

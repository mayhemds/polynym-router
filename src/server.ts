import express, { type Request, type Response, type NextFunction, type ErrorRequestHandler } from "express";
import helmet from "helmet";
import path from "node:path";
import "dotenv/config";
import { aiRouter } from "./routes/ai.js";
import { tasksRouter } from "./routes/tasks.js";
import { loadConfig } from "./config.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_SIZE = "1mb";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
// Coding tasks in /v1/tasks can run for several minutes across
// implement/test/review cycles, so the server-level timeout needs to be
// generous, well beyond Node's 5-minute default.
const SERVER_TIMEOUT_MS = 20 * 60_000;
const DASHBOARD_PATH = path.resolve(process.cwd(), "public", "dashboard.html");

/**
 * Minimal in-memory per-IP rate limiter. Fine for a single-process local
 * dev tool. Swap for a shared store if this ever runs as more than one
 * process.
 */
function createRateLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    if (timestamps.length >= maxRequests) {
      res.status(429).json({ error: "Too many requests, slow down." });
      return;
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}

function main(): void {
  // Fail fast on a broken config rather than accepting requests we cannot route.
  loadConfig();

  const app = express();
  app.disable("x-powered-by");
  // The dashboard is a single self-contained HTML file with inline
  // script/style, deliberately, no build step, no third-party requests.
  // Helmet's default CSP blocks inline script/style, so it's loosened for
  // exactly those two directives and nothing else, still no framing,
  // still no object embeds, still no cross-origin script sources.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/dashboard", (_req: Request, res: Response) => {
    res.sendFile(DASHBOARD_PATH, (error: Error | undefined) => {
      if (error) {
        console.error("Failed to serve dashboard:", error.message);
        res.status(500).json({ error: "Dashboard file not found, expected it at public/dashboard.html" });
      }
    });
  });

  app.use(aiRouter);
  app.use(tasksRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    console.error("Unhandled error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  const server = app.listen(PORT, () => {
    console.log(`Polynym Router listening on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
    console.log("This has no built-in auth. Keep it on localhost or put it behind your own auth layer.");
  });
  server.requestTimeout = SERVER_TIMEOUT_MS;
  server.headersTimeout = SERVER_TIMEOUT_MS + 1000;
}

main();

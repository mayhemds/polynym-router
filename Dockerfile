# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app

# git is required by the coding agent (branch/commit/test loop); the router
# shells out to it against the projects you mount below.
RUN apk add --no-cache git

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Runtime needs these on disk (resolved relative to cwd), not compiled in:
COPY config ./config
COPY public ./public
COPY examples ./examples

# Telemetry + (optionally) mounted project sources live outside the image.
# The data dir is a named volume so the request log survives restarts.
VOLUME ["/app/data"]

EXPOSE 3000

# Runs the compiled HTTP server. Use `node dist/mcp/server.js` in a
# separate process for the MCP stdio transport instead.
CMD ["node", "dist/server.js"]

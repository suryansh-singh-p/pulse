# Same multi-stage pattern as apps/api/Dockerfile. Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t pulse-worker .

# ---- Build stage: install all deps and compile TypeScript ----
FROM node:24.22.3-bookworm-slim AS build

WORKDIR /app

# Package files first, so the install layer stays cached until dependencies change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/

RUN npm ci

COPY . .

# Only this image's packages (a plain `npm run build` would build every app).
RUN npm run build -w @pulse/shared && npm run build -w @pulse/worker

# ---- Runtime stage: only what's needed to run the worker ----
FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN npm ci --omit=dev

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist

USER 1000

# No EXPOSE: the worker serves no traffic; it only consumes from Kafka.
# Exec form: node is PID 1 and receives SIGTERM directly (needed for the final flush).
CMD ["node", "apps/worker/dist/index.js"]

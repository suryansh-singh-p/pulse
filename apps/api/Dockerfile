# ---- Build stage: install all deps and compile TypeScript ----
FROM node:24.22.3-bookworm-slim AS build

# Creates /app if needed; later instructions run here.
WORKDIR /app

# Copy only the package files first, so the install layer stays cached
# until dependencies change. Workspace manifests keep their relative paths.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# Exact install from the lockfile, including dev deps (needed for tsc).
RUN npm ci

COPY . . 

RUN npm run build

# ---- Runtime stage: only what's needed to run the api ----
FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app

# Production deps only (no TypeScript, ESLint, Vitest, tsx).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev

# Compiled output from the build stage.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist

# Run as the unprivileged user that ships with the node image.
USER 1000

# Documents the port the api listens on (doesn't publish it).
EXPOSE 3000

# Exec form: node is PID 1 and receives SIGTERM directly.
CMD ["node", "apps/api/dist/index.js"]

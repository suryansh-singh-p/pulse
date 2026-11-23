# Journal

## 2026-11-21 — Monorepo scaffold and the API

**Built**

- npm workspaces monorepo: `apps/api`, `apps/worker`, `apps/platctl`, `packages/shared`, `deploy`, `terraform`.
- Root tooling: `tsconfig.base.json` (strict, ES2023, NodeNext), ESLint + Prettier, Vitest, `.nvmrc` pinned to Node 24.15.0.
- `@pulse/shared`: zod `EventIn` schema + `StoredEvent` type, and `loadConfig()` that validates env (PORT, REDIS_URL, S3_ENDPOINT, S3_BUCKET, KAFKA_BROKERS) and exits at startup on bad config.
- `@pulse/api` (Fastify): `/healthz`, `/readyz`, `/metrics` (prom-client defaults + request counter + duration histogram), `POST /events` (validate → add id + receivedAt → 202, Kafka stubbed as a log line), `/stats`. JSON logs via pino. Graceful shutdown on SIGTERM/SIGINT with a 10 s timeout.
- Tests: config loader, event schema, and all routes via `app.inject`.

**Gotchas**

- `outDir` in a base tsconfig resolves relative to the base file, so every app would build into one root `dist`. Fixed with `${configDir}/dist` (TS 5.5+).
- TypeScript 6 no longer picks up `@types/node` automatically → added `"types": ["node"]`.
- `npm run build --workspaces` runs alphabetically, so `apps/api` built before `packages/shared`. Root build now builds shared first.
- `index.ts` and the split `events.ts`/`config.ts` drifted into two copies of the same code; tests used one, the API the other. Restored `index.ts` to re-exports only.
- `prom-client` is deprecated in favour of `@prometheus-io/client` (kept for now).
- In PowerShell 5.1, `curl` is `Invoke-WebRequest`; use `curl.exe`.

## 2026-11-22 — Dockerising the API

**Built**

- `.dockerignore` at the repo root (`**/node_modules`, `**/dist`, `**/.env*`, `.git`, `coverage`, `terraform`, `deploy`, OS junk).
- Multi-stage `apps/api/Dockerfile`, built from the repo root with `-f`:
  - build stage: copy only package files → `npm ci` → `COPY . .` → `npm run build` (shared first).
  - runtime stage: `npm ci --omit=dev`, copy both `dist` folders with `COPY --from=build`, non-root user, `EXPOSE 3000`, exec-form `CMD ["node", "apps/api/dist/index.js"]`.

**Learned**

- Layer caching: a step is reused only if the step before it was. Copying package files before `npm ci` keeps the install cached when only code changes.
- In `.dockerignore`, a bare name matches only at the context root; use `**/` for any depth.
- `RUN` runs at build time, `CMD` at container start. Exec-form `CMD` makes node PID 1 so it receives SIGTERM directly.
- No secrets in `ENV`: anything baked in is visible with `docker inspect`.
- `docker stop` sends SIGTERM, then SIGKILL after 10 s. Clean shutdown = `Exited (0)`; killed = `Exited (137)`.

## 2026-11-23 — Kubernetes on kind with Helm

**Built**

- kind cluster `pulse` from `deploy/kind/kind.yaml`: 1 control-plane + 2 workers. metrics-server via Helm with `--kubelet-insecure-tls`. Default namespace `pulse`.
- `pulse-api:dev` loaded into the nodes with `kind load docker-image`.
- `deploy/infra/`: Redis and MinIO as StatefulSets with PVCs and headless Services, readiness probes and resources; MinIO credentials in a Secret created with kubectl (not committed); a Job that creates the `pulse-events` bucket.
- Helm chart `deploy/helm/pulse`: ConfigMap (env), Secret (S3 keys, `required` at install), Deployment (envFrom, `/readyz` readiness, `/healthz` liveness, requests/limits, RollingUpdate maxUnavailable 0 / maxSurge 1, non-root + no privilege escalation + drop ALL + read-only root FS, `terminationGracePeriodSeconds`, preStop sleep 5 s, checksum annotations, topology spread), ClusterIP Service 80 → 3000, HPA (2–5 at 70% CPU) and PDB (minAvailable 1) behind switches. `values-dev.yaml` holds only the kind overrides.
- Installed with `helm upgrade --install`; all routes checked through a port-forward.

**Gotchas**

- VS Code terminals keep the PATH from when VS Code started; after installing kind/helm, fully quit VS Code (or reload `$env:Path`).
- `runAsNonRoot` can only verify a numeric user, so the Dockerfile now uses `USER 1000` instead of `USER node`.
- The official `minio/minio` and `minio/mc` images can no longer be pulled (Docker Hub and quay.io). Switched to `bitnamilegacy/minio` and `bitnamilegacy/minio-client` (frozen, fine for local only). Bitnami runs as uid 1001 and stores data in `/bitnami/minio/data`.
- A StatefulSet can wait forever on a pod that never became Ready; after fixing the spec, delete the stuck pod.
- Jobs are immutable: delete before re-applying.
- On kind, a PVC's size is a label, not a limit (local-path is just a folder on the node).
- `kubectl port-forward svc/...` tunnels to one pod; it is not load-balanced and dies when that pod goes away.

### Drill 1 — Zero-downtime restart

- **Did:** in-cluster curl loop (`curlimages/curl`) hitting `http://pulse/healthz` every 0.2 s, then `kubectl rollout restart deployment/pulse`.
- **Saw:** one new pod → Ready → one old pod Terminating, twice. `failed=0` throughout.
- **Why it worked:** maxUnavailable 0 + maxSurge 1, readiness on `/readyz`, preStop sleep so endpoints are removed before SIGTERM, and the app's graceful shutdown.
- **Lesson:** don't test zero downtime through `port-forward`; it pins one pod and breaks when that pod is replaced. Test through the Service from inside the cluster.

### Drill 2 — Self-healing

- **Did:** `kubectl delete pod pulse-7b4bf55bcf-g8tzf`.
- **Saw:** the ReplicaSet created `pulse-7b4bf55bcf-bf7gl` the same instant (same hash = same ReplicaSet, not a rollout); Ready in 2 s. The old pod took exactly 5 s to stop (the preStop sleep) and ended `Completed` (exit 0) — clean shutdown, not killed.
- **Lesson:** controllers reconcile desired vs actual state; no human needed.

### Drill 3 — Bad image

- **Did:** `helm upgrade ... --set image.tag=does-not-exist`.
- **Saw:** Helm said "Upgrade complete" (revision 2) — it only checks the objects were accepted, not that pods start. A new ReplicaSet's pod went `ErrImagePull` / `ImagePullBackOff`. Both old pods stayed `1/1 Running`, so users saw no errors (maxUnavailable 0).
- **Found it:** `kubectl describe pod` → Events: `pull access denied, repository does not exist` for `docker.io/library/pulse-api:does-not-exist`. With no registry in the name, Kubernetes assumes Docker Hub; the tag was never loaded into kind.
- **Fix:** `helm rollback pulse 1 -n pulse`, which adds a new revision ("Rollback to 1") rather than deleting history.
- **Lesson:** use `helm upgrade --wait --timeout ...` in CI so a release whose pods never become Ready fails instead of reporting success.

### Drill 4 — Broken readiness

- **Did:** `helm upgrade ... --set readinessProbe.httpGet.path=/wrong-path`.
- **Saw:** the new pod sat at `0/1 Running` with 0 restarts, and the rollout stalled. Both old pods kept serving.
- **Found it:** `kubectl describe pod` → `Readiness probe failed: HTTP probe failed with statuscode: 404`; Conditions `Ready=False`. The pod's IP was not a ready endpoint of the `pulse` Service, so it never got traffic.
- **Fix:** `helm rollback pulse -n pulse` (back to the previous revision).
- **Lesson:** readiness only controls traffic; liveness controls restarts. A wrong readiness path stalls a rollout safely. A wrong liveness path would kill healthy containers in a loop (CrashLoopBackOff). Without maxUnavailable 0, old pods would have been removed while the new one never served, cutting capacity.

### Drill 5 — OOMKilled

- **Did:** `helm upgrade ... --set resources.limits.memory=20Mi --set resources.requests.memory=16Mi`. The request had to be lowered too; the API rejects request > limit.
- **Saw:** the new pod started, was killed, restarted, and went into `CrashLoopBackOff` with a rising restart count. Old pods kept serving.
- **Found it:** `kubectl describe pod` → Last State `Terminated`, Reason `OOMKilled`, Exit Code `137` (128 + SIGKILL). Logs were empty or cut off because the kernel kills the process instantly; no graceful shutdown. `kubectl top pods` showed healthy pods need far more than 20Mi.
- **Fix:** `helm rollback pulse -n pulse`.
- **Lesson:** over the CPU limit the container is throttled (slow); over the memory limit it is killed, because memory can't be taken back from a running process. No error in the logs + exit 137 → suspect OOM first. Set limits from measured usage plus headroom.

### Drill 6 — Persistence

- **Did:** `redis-cli set drill persistence-works`, noted the PVC UID and node, then `kubectl delete pod redis-0`.
- **Saw:** the replacement was named `redis-0` again and only started after the old pod was fully gone (a StatefulSet never runs two pods with one identity). `get drill` still returned `persistence-works`; same PVC UID; `ClaimName: data-redis-0`; same node.
- **Why:** the PVC outlives the pod (and even the StatefulSet), and Redis's append-only file writes every change to `/data`. On kind the volume is a folder on one node, so the PV pins `redis-0` to that node.
- **Lesson:** stable name + stable storage is what a StatefulSet adds over a Deployment. A Deployment without a PVC would lose the data on every restart. Deleting the StatefulSet keeps PVCs on purpose; data is only gone when the PVC itself is deleted.

## Open items

- App ignores `LOG_LEVEL` (not in the config schema; Fastify logger is fixed at info).
- `/readyz` doesn't check Redis or Kafka yet; `/stats` returns `{}`.
- Decide on `prom-client` vs `@prometheus-io/client`.
- Bitnami legacy MinIO images get no updates; revisit before anything beyond local.

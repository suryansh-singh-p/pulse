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

## 2026-11-24 — AWS and Terraform: S3 events bucket and least-privilege IAM

**Built**

- AWS account (AWS (new) plan) with root MFA, an admin IAM user `suryansh-admin` with an access key, used through the CLI profile `pulse-admin` (`$env:AWS_PROFILE`, never in code).
- `terraform/` root module:
  - `versions.tf`: Terraform `>= 1.17`, AWS provider `~> 6.0`. `.terraform.lock.hcl` committed so every run uses the same provider build.
  - `providers.tf`: region from a variable; `default_tags` (`project`, `env`, `owner`) on every resource.
  - `variables.tf` + `dev.tfvars`: `region`, `env` (validated: `dev` or `prod`), `bucket_prefix`, `owner`; no defaults, so nothing is applied by accident.
  - `main.tf`: `data "aws_caller_identity"` for the account ID → bucket name `pulse-events-dev-<account-id>` (bucket names are global).
  - `iam.tf`: policy document with three statements: `PutObject`/`GetObject` on `raw/*`, `PutObject` only on `reports/*`, `ListBucket` on the bucket ARN limited by an `s3:prefix` condition to `raw/*` and `reports/*`. Attached to the IAM user `pulse-app`. The access key was created with the CLI, not Terraform, so the secret never entered state.
  - `outputs.tf`: bucket name, bucket ARN, `pulse-app` user ARN.
- `modules/bucket/`: the bucket with versioning, SSE-S3 (AES256), all four public-access-block settings, and lifecycle rules (`raw/` → Standard-IA at 30 days, expire at 90; noncurrent versions deleted after 30 days; expired delete markers removed; incomplete multipart uploads aborted after 7 days). The lifecycle rule `depends_on` versioning.
- Committed the Terraform code (`0d90be1`) and tagged `m7`. State, plans and secrets are gitignored.

**First plan**

- 8 to add. Resources showed only their own arguments in `tags`, while `tags_all` listed the merged `default_tags`: that's how the provider shows tags applied from the provider block.
- Data sources are read during plan (account ID known), but ARNs and IDs of new resources show `(known after apply)`.

**Proving least privilege (as `pulse-app`)**

- Allowed: write and read under `raw/`, write under `reports/`, list those prefixes.
- Denied: `PutObject` at the bucket root, `DeleteObject`, `ListBuckets`. The error said "no identity-based policy allows the action": an **implicit deny**, because nothing allows it.
- Different from the AWS (new) plan's org SCP, whose errors say "with an explicit deny in a service control policy". An explicit deny wins over any allow, even for an admin.
- Evaluation order: default deny → an allow opens it → an explicit deny anywhere closes it again.

**Drift**

- Changed a tag on the bucket by hand in the console. `terraform plan` reported the resource as "changed outside of Terraform" and planned 1 to change, back to the code's value. `apply` reverted it.
- Lesson: Terraform compares code, state and real infrastructure on every plan; manual console changes get undone. `terraform plan -refresh-only` shows drift without proposing changes.

**Module refactor**

- Moved the five bucket resources into `modules/bucket` with `moved` blocks in `main.tf` (`aws_s3_bucket.events` → `module.events_bucket.aws_s3_bucket.this`, and so on). Plan: 0 to add, 0 to destroy. Without `moved`, Terraform would have destroyed and recreated the bucket.
- The module declares `required_providers` without a version; the root sets the version and the configured provider (region, tags) is inherited.
- `moved` blocks are reviewable in a PR and work for everyone; `terraform state mv` is a one-off local command.

**Cleanup**

- A versioned bucket isn't empty until every version and delete marker is gone, so `delete-object --version-id` for each, then `terraform destroy` (force_destroy stays false on purpose). Deleted the `pulse-app` access key and user. Checked: state empty, no buckets, no customer-managed policies.

**Gotchas**

- AWS (new) plan: the region is fixed to `ap-southeast-2`; IAM Identity Center isn't available; an AWS-owned SCP explicitly denies `iam:GetLoginProfile`, so IAM users can't get a console password. The admin user works through an access key only.
- PowerShell 5.1 splits `-var-file=dev.tfvars` at the dot; quote it: `"-var-file=dev.tfvars"`.
- A stray `3441` after a string in `iam.tf` broke `terraform validate`; run validate before plan.
- Never commit `*.tfstate`: state holds every attribute in plain text, and would hold secrets if any were created in Terraform.

## 2026-11-25 — CI/CD with GitHub Actions and GHCR

**Built**

- `typecheck` scripts: each workspace runs `tsc --noEmit`; the root builds `@pulse/shared` first, then type-checks all workspaces.
- `.github/workflows/ci.yaml` on PRs to `main` and pushes to `main`, with `permissions: contents: read`:
  - `test`: checkout → setup-node (version from `.nvmrc`, npm cache) → `npm ci` → lint → typecheck → test → build, each its own step.
  - `image` (`needs: test`): Buildx → build from the repo root with `-f apps/api/Dockerfile`, `load: true`, no push, GHA layer cache (`mode=max`) → Trivy (vulnerabilities only, CRITICAL, ignore unfixed, `exit-code 1`). Trivy pinned to a commit SHA; official actions by major tag.
- `.github/workflows/release.yaml` on pushes to `main` only, with `contents: read` + `packages: write`: login to `ghcr.io` with `GITHUB_TOKEN` → build and push `ghcr.io/suryansh-singh-p/pulse-api` tagged with the commit SHA and `main`, OCI `source` and `revision` labels.
- PR #1 squash-merged. First image: `pulse-api:8d03fac3df0974e8e52974edf0ade0f5a39c6f9a` (for `values-dev.yaml` in H7). Anonymous `docker pull` works.
- Branch ruleset on `main`: PR required (0 approvals, solo), status checks `test` + `image` from GitHub Actions, branches up to date, no force pushes or deletions, empty bypass list.

**Broke in CI but worked locally**

- **No `dist/` on a fresh clone.** `@pulse/shared` resolves to `dist/index.d.ts` and `dist/index.js`, which are gitignored. Locally they were left over from old builds; in CI the api's typecheck and tests would fail with "Cannot find module". Fix: root `typecheck` builds shared first. Caught by deleting `dist/` and running `npm ci` and all four steps locally before pushing.
- **Trivy: 6 CRITICAL in the image, none in our code.** 5 in Debian packages (`libgnutls30`, `perl-base`) and 1 in npm's own bundled `tar` (`/usr/local/lib/node_modules/npm/...`). All came from the pinned `node:24.15.0-bookworm-slim`: old tags stop getting OS patches. Fix: bumped to `node:24.22.3-bookworm-slim` and `.nvmrc` to match; verified locally with `aquasec/trivy:0.76.2` before pushing. Not fixed by lowering the severity or a `.trivyignore`.

**Learned**

- Jobs run on separate fresh VMs and share nothing; `needs` orders them and skips the dependant when one fails.
- A pushed commit to a branch with an open PR re-runs CI (`synchronize`); a push to a branch with no PR runs nothing (only `pull_request` and `push` to `main` are triggers). `pull_request` runs are titled with the PR title, not the commit.
- CI never merges and a red check blocks nothing until branch protection makes it required (PR #1 showed `MERGEABLE` while red).
- A job skipped because of a failed `needs` counts as passing for required checks, so require `test` itself, not just `image`.
- `GITHUB_TOKEN` is created per run and expires with it; listing `permissions` turns everything unlisted off. PR runs never publish.
- A package pushed from a workflow with `GITHUB_TOKEN` is linked to the repo and inherits its visibility (public repo → public package). Pushed with a personal token, it starts private.
- Deploy by SHA tag (immutable, traceable, easy rollback), not `main`/`latest`.
- Pin for reproducibility, scan to find out when the pin has gone stale, then bump.

**Gotchas**

- The ruleset ended up with "Restrict creations" and "Restrict updates" ticked, which would have blocked every merge (merging updates `main`). The UI looked right; `gh api repos/<owner>/<repo>/rules/branches/main` showed the real rules.
- In a solo repo, required approvals must be 0: you can't approve your own PR.
- With `main` protected, even journal changes go through a PR.
- kind nodes are Docker containers with a restart policy, so the cluster comes back (and uses ~1.3 GB RAM) whenever Docker Desktop starts. `docker stop`/`docker start` keeps everything; `kind delete cluster` wipes it.

## 2026-11-25 — GitOps with ArgoCD

**Built**

- ArgoCD v3.6.3 in namespace `argocd` from the pinned install manifest (not `stable`), UI through `kubectl port-forward svc/argocd-server -n argocd 8080:443`, initial admin password from `argocd-initial-admin-secret`.
- Chart: `s3.existingSecret`. When set, the chart renders no Secret and the Deployment's `secretRef` points at the named one (helper `pulse.s3SecretName`); `checksum/secret` is skipped because Helm can't hash a Secret it never sees. The old `--set s3.accessKey=...` path still works.
- `values-dev.yaml`: image `ghcr.io/suryansh-singh-p/pulse-api` at SHA `8d03fac…` with `IfNotPresent`, `existingSecret: pulse-s3`, HPA off so Git owns the replica count.
- `deploy/argocd/application.yaml`: Application `pulse` in `argocd`; source = this repo, `main`, `deploy/helm/pulse`, `values-dev.yaml`; destination = `https://kubernetes.default.svc`, namespace `pulse`; automated sync with `prune` and `selfHeal`, `CreateNamespace=true`, and the resources finalizer.
- Handover: chart changes merged first (PR #4), then `helm uninstall pulse -n pulse`, then `pulse-s3` recreated by hand from `minio-credentials` (decoded into variables, never printed), then one `kubectl apply` of the Application. Synced and Healthy; `/healthz` OK through `port-forward svc/pulse`.

**Pull-based GitOps vs CI pushing**

- Push: CI (or a laptop) runs `kubectl`/`helm` against the cluster. It needs cluster credentials outside the cluster, deploys only when it runs, and doesn't notice manual changes afterwards.
- Pull: a controller inside the cluster compares Git with the cluster and applies the difference. No cluster credentials leave the cluster, Git is the single source of truth, deploy = merge, rollback = `git revert`, and manual changes are reverted.
- CI and CD are decoupled: CI builds and publishes an image for every merge; nothing deploys until a PR changes the tag in `values-dev.yaml`.
- Git is polled (about every 3 minutes, or Refresh in the UI); the cluster is watched live, so drift in the cluster is seen immediately.
- Helm's role changed: ArgoCD still uses it to render the chart, but applies and tracks the objects itself. There is no Helm release, so `helm list` is empty, and history and rollback live in Git.

**Drills**

### Drill — Deploy through Git

- **Action:** add `replicaCount: 3` to `values-dev.yaml`, PR, merge; Refresh in the UI.
- **Expected:** app OutOfSync for a moment, then a third pod. Same ReplicaSet and `rev:1`: replicas aren't part of the pod template, so it's a scale, not a rollout.
- **Lesson:** Git is the control panel; no kubectl needed.

### Drill — Self-heal

- **Action:** `kubectl scale deploy/pulse -n pulse --replicas=1`.
- **Expected:** ArgoCD sees the drift within seconds (it watches the cluster), shows OutOfSync, and scales back to the Git value.
- **Lesson:** with `selfHeal`, a manual change lasts seconds. With the HPA on, the HPA would reset it instead, which is why it's off for these drills.

### Drill — Ship a new version

- **Action:** add a `version` field to `/healthz` (e.g. the commit SHA passed as a build arg), merge; `release.yaml` pushes a new image; put its SHA in `values-dev.yaml`, merge.
- **Expected:** a new ReplicaSet (new pod-template hash, `rev:2`); pods replaced one at a time (maxSurge 1, maxUnavailable 0); `/healthz` reports the new version.
- **Lesson:** two PRs, two decisions: build the artifact, then choose to deploy it.

### Drill — Roll back through Git

- **Action:** `git revert` the tag-bump commit on a branch, PR, merge.
- **Expected:** the old tag is back in Git; ArgoCD rolls the Deployment back to the previous image, reusing the old ReplicaSet.
- **Lesson:** rollback is just another commit, reviewed and recorded like any change.

### Drill — Bad deploy

- **Action:** set `image.tag` to a tag that doesn't exist, PR, merge.
- **Expected:** the new pod goes `ErrImagePull` → `ImagePullBackOff`; app Synced (cluster matches Git) but not Healthy: Progressing, then Degraded once the Deployment's progress deadline (600 s) passes. The old pods keep serving because maxUnavailable is 0. Fix with `git revert`.
- **Lesson:** sync status and health are separate questions; a bad deploy is visible and safe, not an outage.

### Drill — Prune

- **Action:** set `pdb.enabled: false` in `values-dev.yaml`, PR, merge.
- **Expected:** the chart no longer renders the PDB, and ArgoCD deletes it from the cluster. Without `prune: true` it would stay, marked as needing pruning.
- **Lesson:** deleting from Git deletes from the cluster; nothing lingers unmanaged.

**Gotchas**

- The chart's `required` S3 keys came from `--set` at install. ArgoCD renders only from Git, so the sync would have failed with "set s3.accessKey". Fixed with `existingSecret`, not by committing keys.
- With the HPA on, the template leaves out `replicas`, so `replicaCount` in Git would be ignored and the HPA, not ArgoCD, would undo a manual scale.
- The Application's name is the Helm release name; it has to be `pulse` to keep object names (`Deployment pulse`, `Service pulse`).
- `valueFiles` is relative to `source.path`, not the repo root.
- ArgoCD's CRDs exceed the 256 KB `last-applied-configuration` annotation: install with `kubectl apply --server-side --force-conflicts`.
- The namespace must be `argocd`: the manifest's ClusterRoleBindings refer to service accounts there.
- Order matters: Git first (ArgoCD reads `main`), then uninstall the Helm release (one owner per object), then the Secret (pods need it to start), then the Application. The api is down between uninstall and the first sync.
- `helm uninstall` also deleted the chart-made `pulse-s3` Secret.
- Pods showed `running 0/1` for the first seconds: readiness got "connection refused" while Node started, then `/readyz` returned 200.
- Public repo and public GHCR package: no repo credentials and no `imagePullSecrets` needed.

## 2026-11-26 — Kafka: producer, worker and stats

**Built**

- `deploy/compose.yaml` (project `pulse`): Kafka 4.4.0 in single-node KRaft mode (broker + controller, no ZooKeeper), a one-shot `kafka-init` that creates `events.raw` (3 partitions, replication factor 1), Redis, MinIO (bucket via `MINIO_DEFAULT_BUCKETS`), the api and the worker. Credentials from `deploy/.env` (gitignored; `.env.example` committed).
- Kafka listeners: `PLAINTEXT` `:9092` advertised as `kafka:9092` for containers, `EXTERNAL` `:9094` advertised as `localhost:9094` for the laptop, `CONTROLLER` `:9093` for KRaft only.
- The api waits for `kafka-init` to complete (not just Kafka healthy), and auto topic creation is off, so `events.raw` can't silently appear with 1 partition.
- api producer (KafkaJS): one producer at startup, `DefaultPartitioner` (murmur2, same as the Java client), key = `userId`, `acks: -1`, 2 short retries and a 3 s send timeout → 202 only after Kafka's ack, otherwise 503 + `Retry-After: 5`. `/readyz` runs a Kafka metadata request and a Redis PING in parallel, 1 s timeout each, and names what failed. Shutdown: close the server, then disconnect the producer, then Redis. Kafka and Redis are injected through small interfaces (`deps.ts`), so tests and CI use fakes.
- Shared contract in `@pulse/shared`: the `StoredEvent` zod schema plus `EVENTS_TOPIC` and `COUNTS_KEY`.
- `apps/worker`: consumer group `pulse-worker`, auto-commit off. Per batch: validate (invalid → log and skip), one Redis pipeline of `HINCRBY counts <type> n`, buffer, record the next offset per partition. Flush at 500 events or 30 s: one NDJSON file at `raw/dt=YYYY-MM-DD/hour=HH/<uuid>.ndjson` (S3 SDK, `forcePathStyle` for MinIO), then commit. Flushes are serialized; 3 failed writes or any Redis/consumer error → exit without committing.
- `GET /stats` → `{ counts, total }` from `HGETALL counts`, 503 if Redis fails.
- Worker Dockerfile (same multi-stage pattern); both Dockerfiles build only their own workspace. CI's `image` job builds and scans both images; `release.yaml` pushes `pulse-api` and `pulse-worker`.

**How partitioning works**

- The producer picks the partition, not the broker: `positive(murmur2(key)) % partitions`. alice and bob → 0, carol → 2; the same key always lands on the same partition, so a user's events stay in order.
- Order holds only within a partition. The console consumer printed all of partition 0, then partition 2, so carol's 3rd event came out last.
- Adding partitions changes `% partitions` and moves keys (alice would go to 1 with 4 partitions), breaking per-key order across the change.

**Drills**

### Drill — End to end

- **Did:** sent 1,000 events (types rotating, 50 users).
- **Saw:** `/stats` total 1009 (9 + 1000; click 340, page_view 333, purchase 336). Worker flushed `events: 500, reason: size` twice; lag 0 on all partitions; NDJSON files in MinIO under `raw/dt=.../hour=.../`.

### Drill — Consumer groups

- **Did:** `docker compose up -d --scale worker=2`, then sent 300 events.
- **Saw:** a rebalance (KafkaJS logs "The group is rebalancing, so a rejoin is needed" at ERROR level, but it's normal), then worker-2 flushed 78 and worker-1 flushed 222: the partitions were split between them, unevenly because the 50 users don't hash evenly. Total 1309.

### Drill — Crash safety

- **Did:** sent 500 events and immediately `docker compose kill worker` (SIGKILL, both workers, before the 30 s flush).
- **Saw:** `/stats` already 1809 (counted on read). Consumer group: "no active members", LAG 150 / 130 / 220 = 500, committed offsets 396 / 340 / 573 (sum 1309 = everything flushed before the crash), log-end offsets 546 / 470 / 793 (sum 1809 = everything sent). After `docker compose start worker`: LAG 0, the 500 written to S3 once, `/stats` 2309.
- **Lesson:** at-least-once. Committed offsets live in Kafka, so nothing was lost; the counter over-counted by exactly the uncommitted 500. Event ids would make the counter idempotent (`SET seen:<id> NX`).
- `docker kill` counts as a manual stop, so `restart: on-failure` didn't restart the workers; a real crash would have been restarted.

### Drill — More workers than partitions

- **Action:** `--scale worker=4`, then `kafka-consumer-groups.sh --describe --group pulse-worker --members`.
- **Expected:** 4 members, one with `#PARTITIONS 0`.
- **Lesson:** a partition goes to one consumer per group, so partitions cap parallelism; an extra worker is an idle standby that takes over if another dies.

### Drill — Kafka down

- **Action:** `docker compose stop kafka`, then `/readyz`, `/stats` and `POST /events`; then `docker compose start kafka`.
- **Expected:** `/readyz` 503 with `failed.kafka`, `POST /events` 503 after about 3 s, `/stats` still 200 (Redis only), workers exiting and restarting. After Kafka is back: everything recovers without manual steps.
- **Lesson:** fail fast with a clear temporary error, recover automatically.

**Gotchas**

- Listeners: the advertised address must be reachable from where the client runs. Advertising only `localhost` breaks every container client ("localhost" inside a container is the container itself).
- `apache/kafka`: setting any `KAFKA_*` variable drops the image's built-in config, so the whole KRaft config has to be spelled out; internal topics need replication factor 1 on a single broker.
- Auto topic creation would have created `events.raw` with 1 partition if the api produced before `kafka-init` ran.
- ioredis queues commands while disconnected, so a PING with Redis down hangs; `enableOfflineQueue: false` makes it fail fast.
- KafkaJS: `stop()`/`disconnect()` make `commitOffsets` throw, so shutdown must pause → finish the batch → flush → commit → disconnect. After a crash it restarts the consumer itself while old events are still buffered; the worker exits instead.
- The api Dockerfile ran `npm run build`, which built every workspace, including the worker whose deps aren't installed in that image. Found by building the image locally before pushing.
- CI: a matrix would rename the required check to `image (api)` / `image (worker)` and block every PR; both images build in the one `image` job instead, with separate GHA cache scopes so they don't overwrite each other.
- KafkaJS 2.2.4 (last release Feb 2023) logs `TimeoutNegativeWarning` on Node 24: `throttledUntil` starts at -1, so `-1 - Date.now()` is passed to `setTimeout`. Harmless (Node uses 1 ms).
- PowerShell: use `Invoke-RestMethod` for JSON POSTs (curl.exe quoting), and a `dc` function for `docker compose -f deploy/compose.yaml`.

## 2026-11-26 — Kafka on Kubernetes, the worker, and code to pods through Git

**Built**

- `deploy/infra/kafka.yaml`: Kafka 4.4.0 as a StatefulSet (1 broker, KRaft) with a 2 Gi PVC for its log directory, so topics and committed offsets survive pod restarts. Headless Service `kafka`; the broker advertises its stable per-pod name `kafka-0.kafka:9092`. Heap 256–512 MB, memory limit 1 Gi. TCP readiness probe.
- `deploy/infra/kafka-topic-job.yaml` creates `events.raw` (3 partitions). It and the existing `minio-create-bucket` Job are ArgoCD `PostSync` hooks with `BeforeHookCreation`: re-run after every sync, both idempotent.
- `deploy/argocd/infra-application.yaml`: Application `pulse-infra` for `deploy/infra/` (plain YAML), namespace `pulse`, automated prune + self-heal, `ServerSideDiff=true`, no resources finalizer (deleting it leaves the data running). It adopted the hand-applied Redis and MinIO without restarting them (PR #7).
- Chart 0.2.0 (PR #8): worker Deployment behind `worker.enabled`, using the api's ConfigMap and Secret and, by default, the api's image tag. Own name label `pulse-worker`, no Service, no probes, `terminationGracePeriodSeconds: 30` (above the worker's 20 s shutdown). Added the missing `AWS_REGION`. Merged with the worker off: the api pods rolled once (config checksum), same image.
- First real release (PR #9): `image.tag` from `8d03fac` (pre-Kafka api) to `c53e33b`, worker on with 2 replicas (partitions split 2 + 1) and a 10 s flush.
- Demo page (PR #10): `GET /` serves one HTML page from a `.ts` module (so it is compiled into `dist/` and the image). Buttons `POST /events` (users `user-1`…`user-20`, so all partitions get work), a 100-event burst, `/stats` polled every 2 s, values rendered with `textContent`, `cache-control: no-store`. The chart passes the image tag as `APP_VERSION`, shown on the page. Released in PR #11 (`0f5c449`).
- Root `README.md` (architecture and delivery diagrams, screenshots in `docs/images/`, how to run, decisions, limitations), `deploy/README.md` rewritten for ArgoCD, `deploy/.env.example` re-added (PR #12 and this one).

**Who watches what**

- GitHub Actions watches merges to `main` and builds images from `apps/`. Every merge adds `pulse-api:<sha>` and `pulse-worker:<sha>` to GHCR; nothing runs them yet.
- ArgoCD watches `deploy/helm/pulse/` and `deploy/infra/` on `main`, renders them, and applies the difference. It never looks at `apps/`.
- The only link between the two is `image.tag` in `values-dev.yaml`. The tag decides *which* code runs; every other chart value decides *how* it runs.
- So a code-only PR changes nothing in the cluster (PR #6); a settings PR restarts pods on the same image (PR #8, and PR #10's `APP_VERSION`); a tag PR deploys new code (PRs #9, #11). Until PR #9, the cluster ran the ArgoCD-day image while every newer commit only ran in Compose, which builds from local files.
- Release = two merges, because the tag is the SHA of a merge commit that doesn't exist until the code PR is merged. Companies keep the two steps but let a bot open the tag PR (auto-merged for dev, approved for prod), or use ArgoCD Image Updater.
- ArgoCD's "Synced to `b9e1794`" is the commit it read the chart from; the image tag inside is a different commit (`c53e33b`).
- Runtime vs deploy coupling: the api and worker are decoupled at runtime (Kafka buffers, either side can be down or scaled), but share one tag because they share the `StoredEvent` contract. `worker.image.tag` can split them; then the event schema must stay backward compatible.

**Drills**

### Drill — Code to pods

- **Action:** merge a code PR, wait for `release.yaml`, merge a PR that sets `image.tag` to the new SHA; watch the ArgoCD tree and `kubectl get pods -n pulse -w`.
- **Expected:** a new ReplicaSet for the api and for the worker; pods replaced one at a time; the demo page's version changes to the new SHA after a reload.
- **Lesson:** CI builds, Git decides, ArgoCD applies.

### Drill — Worker pod deleted

- **Action:** `kubectl delete pod -n pulse <a pulse-worker pod>` while sending events from the demo page.
- **Expected:** the worker leaves the group cleanly (SIGTERM → flush → commit), the other worker briefly takes all 3 partitions, the replacement pod rejoins and the partitions are split again. Counts and files keep growing; nothing is lost.
- **Lesson:** a consumer group rebalances around missing members; graceful shutdown avoids duplicates.

### Drill — Kafka pod deleted

- **Action:** `kubectl delete pod -n pulse kafka-0`, then `/readyz` and a demo-page click; wait for `kafka-0` to be 1/1.
- **Expected:** the StatefulSet recreates `kafka-0` with the same name and the same PVC. Meanwhile `/readyz` is 503 (`failed.kafka`) and `POST /events` returns 503; workers exit and are restarted. Afterwards the topic and the group's committed offsets are still there, and the workers resume where they stopped.
- **Lesson:** stable identity + persistent volume is why stateful services are StatefulSets.

### Drill — Roll back a release

- **Action:** `git revert` the demo-page release commit on a branch, PR, merge.
- **Expected:** the api and worker go back to `c53e33b` (the previous ReplicaSets are reused); `GET /` returns 404 again.
- **Lesson:** rollback is a commit, and the old image never left GHCR.

**Gotchas**

- A headless Service publishes DNS names only for Ready pods, but Kafka must resolve `kafka-0.kafka` to become Ready. Fix: `publishNotReadyAddresses: true`.
- `apache/kafka` turns every `KAFKA_*` environment variable into broker config, and Kubernetes can inject `KAFKA_PORT` etc. for Services: `enableServiceLinks: false`.
- The JVM uses memory outside the heap: a memory limit at or below `-Xmx` gets the pod OOMKilled.
- A Job's pod template can't be changed after creation, so a Job managed as a normal ArgoCD resource eventually fails to sync. Hooks are deleted and re-created instead.
- Label selectors match any pod that has *at least* their labels. Worker pods carrying `name: pulse, instance: pulse` would have received the api Service's traffic and counted towards its PDB. And a Deployment's selector is immutable, so the api's couldn't be narrowed instead: the worker got its own `name` label.
- No `pulse-worker` image exists for commits before PR #6, so the worker was enabled in the same PR as the tag bump.
- The chart never set `AWS_REGION`: the old api didn't use S3, but the S3 SDK requires a region.
- `kubectl get pods,pvc -w`: watch takes one resource type.
- `gh pr checks` without a number finds the PR from the current branch (none on `main`); right after `gh pr create` it can say "no checks reported". `gh pr merge` while checks are pending is blocked by the ruleset; switching back to `main` then makes the branch's files "disappear" until the PR is merged.
- `kubectl port-forward svc/...` dies when the pod behind it is replaced; restart it after a rollout.
- The Bitnami MinIO console (9001) isn't served in the cluster pod; inspect the bucket with `mc` inside `minio-0` instead.

## Open items

- App ignores `LOG_LEVEL` (not in the config schema; Fastify logger is fixed at info).
- Decide on `prom-client` vs `@prometheus-io/client`.
- Bitnami legacy MinIO images get no updates; revisit before anything beyond local.
- Add Dependabot (npm, Dockerfile base image, GitHub Actions) so stale pins arrive as PRs.
- `release.yaml` runs in parallel with CI on `main` and doesn't wait for it.
- `*.test.ts` files are excluded from tsconfig, so their types are never checked.
- Terraform state is local; move it to a remote backend (S3 with locking) before anyone else runs it.
- `suryansh-admin`'s access key is full admin with no expiry: deactivate it when AWS isn't in use.
- `pulse-s3` is created by hand; replace with Sealed Secrets or External Secrets Operator so it's reproducible from Git.
- HPA is off in dev for the GitOps drills; turn it back on (with `replicas` left out of Git).
- ArgoCD itself and its two Applications are applied with kubectl; manage them from Git too (app-of-apps).
- Change the ArgoCD admin password (or disable admin and use SSO) and delete `argocd-initial-admin-secret`.
- KafkaJS is unmaintained; move to `@confluentinc/kafka-javascript` (KafkaJS-compatible API on librdkafka).
- De-duplicate counts by event `id` in Redis (`SET seen:<id> NX EX ...`) to make counting effectively exactly-once.
- No dead-letter queue: invalid events are only logged and skipped.
- Release tag bumps are manual PRs. Automate with a bot PR from `release.yaml` (needs a GitHub App or personal token: PRs opened with `GITHUB_TOKEN` don't trigger CI, so required checks would never run) or ArgoCD Image Updater.
- The worker has no liveness probe: a hung worker (not crashed) wouldn't be restarted. Add a heartbeat file or a small `/healthz`.
- Monitoring not done yet: kube-prometheus-stack, a ServiceMonitor for the api's `/metrics`, a Grafana dashboard (req/s, error %, p95, restarts) and an error-rate PrometheusRule.
- Kafka is one broker with replication factor 1: no fault tolerance.

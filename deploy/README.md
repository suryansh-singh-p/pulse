# Running pulse locally

Two ways to run the whole system on a laptop:

| | Docker Compose | kind + ArgoCD |
|---|---|---|
| Use it for | Coding: quick runs of your local changes | The deployed environment: GitOps, rollouts, self-healing |
| Images | Built from your working copy | Pulled from GHCR, by the tag in `values-dev.yaml` |
| Changes arrive by | `up -d --build` | A merged PR (ArgoCD syncs from `main`) |

Run one at a time: together they need more memory than most laptops have.
Commands run from the repo root and work in PowerShell or bash.

## Layout

| Path | What it is | Applied by |
|---|---|---|
| `compose.yaml`, `.env.example` | The whole stack for Docker Compose | `docker compose` |
| `kind/kind.yaml` | Cluster: 1 control-plane + 2 workers, named `pulse` | `kind` |
| `infra/` | Kafka, Redis and MinIO (StatefulSets with volumes), plus the topic and bucket Jobs. Plain YAML | ArgoCD Application `pulse-infra` |
| `helm/pulse/` | Helm chart for the api and the worker. `values.yaml` = defaults, `values-dev.yaml` = this cluster | ArgoCD Application `pulse` |
| `argocd/` | The two Applications | `kubectl apply`, once |

Everything in the `pulse` namespace comes from Git except the two Secrets, which are created by hand so no credentials are committed.

## Docker Compose

```sh
cp deploy/.env.example deploy/.env    # choose your own MinIO password (8+ characters)
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

| What | Where |
|---|---|
| api and demo page | http://localhost:3000 |
| MinIO console | http://localhost:9001 (user and password from `deploy/.env`) |
| Kafka, from the laptop | `localhost:9094` |

Stop with `docker compose -f deploy/compose.yaml stop` (keeps data), or `down -v` to delete it.

## kind + ArgoCD: first-time setup

Needs Docker Desktop with about 6 GB of memory (turn off its own Kubernetes), and `kind`, `kubectl` and `helm`.

**1. Cluster**

```sh
kind create cluster --config deploy/kind/kind.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=120s
kubectl create namespace pulse
```

**2. metrics-server** (optional: for `kubectl top` and the HPA). On kind it must skip kubelet TLS verification, which is for local use only.

```sh
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --set "args={--kubelet-insecure-tls}"
```

**3. ArgoCD**, pinned. Server-side apply, because its CRDs are too large for a normal apply.

```sh
kubectl create namespace argocd
kubectl apply -n argocd --server-side -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.3/manifests/install.yaml
kubectl wait --for=condition=Available deployment --all -n argocd --timeout=300s
```

**4. Secrets.** Both hold the same MinIO user and password. The password must be at least 8 characters and URL-safe (no `@`, `:` or `/`), because the bucket Job puts it in a URL.

```sh
kubectl create secret generic minio-credentials -n pulse --from-literal=rootUser=<user> --from-literal=rootPassword=<password>
kubectl create secret generic pulse-s3 -n pulse --from-literal=AWS_ACCESS_KEY_ID=<user> --from-literal=AWS_SECRET_ACCESS_KEY=<password>
```

**5. The two Applications.** Infra first, because the api and worker need Kafka and Redis to start.

```sh
kubectl apply -f deploy/argocd/infra-application.yaml
kubectl get pods -n pulse -w          # until kafka-0, redis-0, minio-0 are 1/1 and both Jobs Completed
kubectl apply -f deploy/argocd/application.yaml
kubectl get applications -n argocd    # both Synced / Healthy
```

ArgoCD deploys from this repository's `main` branch. In a fork, change `repoURL` in both files.

## Everyday use

**Open things in the browser** (each port-forward runs until you stop it, and stops if its pod is replaced):

| What | Command | Then open |
|---|---|---|
| api and demo page | `kubectl port-forward -n pulse svc/pulse 3000:80` | http://localhost:3000 |
| ArgoCD UI | `kubectl port-forward -n argocd svc/argocd-server 8080:443` | https://localhost:8080, user `admin` |

The ArgoCD admin password is in the Secret `argocd-initial-admin-secret` (key `password`, base64).

**Release a new version** (after the code is merged and `release.yaml` has finished):

1. Get the merge commit's SHA: `git log -1 --format=%H` on an up-to-date `main`.
2. On a branch, set `image.tag` in `helm/pulse/values-dev.yaml` to that SHA. The worker uses the same tag.
3. PR, wait for the checks, merge.
4. ArgoCD syncs within about 3 minutes. To make it look now: `kubectl annotate application pulse -n argocd argocd.argoproj.io/refresh=normal --overwrite`.

**Roll back:** `git revert` the release commit on a branch, PR, merge. The old image is still in GHCR.

**Look around:**

| Question | Command |
|---|---|
| Is everything running? | `kubectl get pods -n pulse` |
| Are both Applications in sync? | `kubectl get applications -n argocd` |
| What are the workers doing? | `kubectl logs -n pulse -l app.kubernetes.io/name=pulse-worker --tail=20` |
| Which worker has which partition, and how far behind? | `kubectl exec -n pulse kafka-0 -- /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group pulse-worker` |
| Does the topic exist? | `kubectl exec -n pulse kafka-0 -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic events.raw` |
| Why is a pod unhappy? | `kubectl describe pod -n pulse <name>` (read Events), `kubectl logs -n pulse <name> --previous` |

## Stop and tear down

- Pause: `docker stop pulse-control-plane pulse-worker pulse-worker2`. Resume with `docker start ...`; everything comes back, data included.
- Delete everything, data included: `kind delete cluster --name pulse`.

## Notes

- **Don't change the cluster with kubectl or helm.** ArgoCD has `selfHeal` on and reverts manual changes within seconds. Change Git instead.
- **The setup Jobs are ArgoCD hooks.** `kafka-create-topic` and `minio-create-bucket` run after every sync of `pulse-infra`; both are safe to run again. A plain Job can't be updated, so ArgoCD deletes and recreates them.
- **Deleting `pulse-infra` keeps the data services running** (no finalizer). Deleting `pulse` deletes the api and worker.
- **MinIO images:** the official `minio/minio` and `minio/mc` images can no longer be pulled, so `infra/` uses `bitnamilegacy/minio` and `bitnamilegacy/minio-client`. They are frozen (no updates): fine for local use only. Their console (port 9001) isn't served in the cluster.
- **Port-forward isn't load-balanced:** `kubectl port-forward svc/pulse` connects to one pod.
- **Memory:** Kafka requests 768 Mi; the whole cluster with ArgoCD uses a few GB.

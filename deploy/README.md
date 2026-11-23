# Deploying pulse locally (kind + Helm)

Runs the pulse API, Redis and MinIO on a local 3-node Kubernetes cluster.
Commands are run from the repo root and work in PowerShell or bash.

## Layout

| Path | What it is |
|---|---|
| `kind/kind.yaml` | Cluster definition: 1 control-plane + 2 workers, named `pulse` |
| `infra/` | Redis and MinIO StatefulSets (with PVCs and Services) and the bucket-creation Job |
| `helm/pulse/` | Helm chart for the API. `values.yaml` = defaults, `values-dev.yaml` = kind overrides |

## Prerequisites

- Docker Desktop running, with ~6 GB of memory available. Turn off Docker Desktop's own Kubernetes.
- `kind`, `kubectl` and `helm` on your PATH (`kind version`, `kubectl version --client`, `helm version`).

## 1. Create the cluster

```sh
kind create cluster --config deploy/kind/kind.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=120s
kubectl create namespace pulse
kubectl config set-context --current --namespace=pulse
```

## 2. Install metrics-server

Needed for `kubectl top` and the HPA. On kind it must skip kubelet TLS verification (local only, never in production).

```sh
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --set "args={--kubelet-insecure-tls}"
```

Check after about a minute: `kubectl top nodes`.

## 3. Build the API image and load it into kind

There is no registry yet, so the image is copied into each node.

```sh
docker build -f apps/api/Dockerfile -t pulse-api:dev .
kind load docker-image pulse-api:dev --name pulse
```

## 4. Redis and MinIO

Create the MinIO credentials first. They are not stored in the repo. The password must be at least 8 characters and URL-safe (no `@`, `:` or `/`), because the bucket Job puts it in a URL.

```sh
kubectl create secret generic minio-credentials --from-literal=rootUser=<minio-user> --from-literal=rootPassword=<minio-password>
kubectl apply -f deploy/infra/
kubectl get pods,pvc,jobs
```

Wait for `redis-0` and `minio-0` to be `1/1 Running`, both PVCs `Bound`, and the `minio-create-bucket` Job `1/1`.

## 5. Install the API

The S3 values must match the MinIO credentials above. Pass them on every install or upgrade; never put them in a values file.

```sh
helm upgrade --install pulse deploy/helm/pulse -n pulse -f deploy/helm/pulse/values-dev.yaml --set s3.accessKey=<minio-user> --set s3.secretKey=<minio-password>
kubectl get pods -l app.kubernetes.io/instance=pulse -w
```

Preview what would be applied without installing: replace `upgrade --install` with `template` and drop `-n pulse`.

## 6. Check it

```sh
kubectl port-forward svc/pulse 3000:80
```

In another terminal (in PowerShell use `curl.exe`):

```sh
curl -i localhost:3000/healthz
curl -i localhost:3000/readyz
curl -s localhost:3000/metrics
kubectl get hpa,pdb
kubectl top pods
```

## Everyday commands

| Task | Command |
|---|---|
| Deploy a code change | rebuild, `kind load docker-image pulse-api:dev --name pulse`, then `kubectl rollout restart deployment/pulse` (same tag, so Kubernetes won't roll out by itself) |
| Release history | `helm history pulse -n pulse` |
| Roll back | `helm rollback pulse <revision> -n pulse` (omit the revision for the previous one) |
| Why is a pod unhappy? | `kubectl describe pod <name>` (read Events), `kubectl logs <name> --previous` |

## Tear down

```sh
kind delete cluster --name pulse
```

This deletes everything, including the Redis and MinIO data.

## Notes

- **MinIO images:** the official `minio/minio` and `minio/mc` images can no longer be pulled. `infra/` uses `bitnamilegacy/minio` and `bitnamilegacy/minio-client`. They are frozen (no updates), so they're fine for local work only.
- **Port-forward is not load-balanced:** `kubectl port-forward svc/pulse` tunnels to one pod and stops when that pod is replaced. To test zero-downtime rollouts, send requests to `http://pulse` from a pod inside the cluster.
- **Jobs can't be edited:** to change and re-run the bucket Job, `kubectl delete job minio-create-bucket` first.
- **`helm upgrade` succeeds before pods are ready.** Add `--wait --timeout 2m` to make it fail if the new pods never become Ready.

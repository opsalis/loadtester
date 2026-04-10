# Deployment Guide — LoadTester

## Prerequisites

- k3s cluster with nodes labeled by region
- kubectl configured with RBAC for Job creation
- Docker for building images

## 1. Build Images

```bash
cd backend

# API server
docker build -t opsalis/loadtester-api:latest .

# Worker (same codebase, different CMD)
docker build -t opsalis/loadtester-worker:latest .

docker push opsalis/loadtester-api:latest
docker push opsalis/loadtester-worker:latest
```

## 2. Label Nodes

```bash
kubectl label node k3s-ca topology.kubernetes.io/region=americas
kubectl label node k3s-de topology.kubernetes.io/region=europe-de
kubectl label node k3s-uk topology.kubernetes.io/region=europe-uk
kubectl label node k3s-sg topology.kubernetes.io/region=asia
```

## 3. Deploy

```bash
kubectl apply -f backend/k8s/service.yaml
kubectl apply -f backend/k8s/deployment.yaml
```

The deployment includes:
- Namespace
- ServiceAccount with RBAC for creating Jobs
- API Deployment with PVC
- Service + Ingress

## 4. Create Secrets

```bash
kubectl create secret generic loadtester-secrets -n loadtester \
  --from-literal=api-key=YOUR_API_KEY
```

## 5. Verify

```bash
kubectl get pods -n loadtester
kubectl port-forward -n loadtester svc/loadtester-api 3400:3400
curl http://localhost:3400/health
```

## 6. How Tests Execute

1. API server receives test creation request
2. After domain verification, API creates k8s Jobs using the job-template.yaml
3. One Job per region, each with nodeSelector targeting that region
4. Workers run for the specified duration
5. Workers POST metrics to API via internal service URL
6. Jobs auto-clean after 300 seconds (ttlSecondsAfterFinished)

## 7. Website

```bash
cd website
npx wrangler pages deploy . --project-name=loadtester-website
```

## Monitoring

```bash
# Watch API logs
kubectl logs -n loadtester -l component=api -f

# Watch worker Jobs
kubectl get jobs -n loadtester
kubectl logs -n loadtester -l component=worker -f
```

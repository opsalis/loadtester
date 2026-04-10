# CLAUDE.md — LoadTester

> Read this first. All facts here are traceable to source code.

## What is LoadTester

Distributed load testing service. Load comes from 4 continents simultaneously via k3s Jobs. Customers specify target URL, RPS, and duration — workers across all nodes hammer the target and report real-time metrics.

**Anti-DDoS:** Before firing a single request, the API verifies domain ownership via a verification file (same concept as Let's Encrypt). No bypass.

## Relationship to Opsalis

This project runs on the Opsalis network as an independent business.
Registers services, earns USDC through 95/5 settlement, runs in Docker containers.
No changes to Opsalis core code required.

## Repository Structure

```
backend/
  index.ts          — Express API: create test, get results, cancel
  worker.ts         — HTTP load generator (RPS, duration, keep-alive)
  aggregator.ts     — Collect results from all nodes, compute percentiles
  package.json
  tsconfig.json
  Dockerfile
  k8s/
    job-template.yaml  — k8s Job per test (scales across nodes)
    deployment.yaml    — API server
    service.yaml

website/
  index.html        — "Load test from 4 continents simultaneously"
  dashboard.html    — Real-time test results
  terms.html
  wrangler.toml

docs/
  API_REFERENCE.md
  DEPLOYMENT.md
```

## Tech Stack

- Runtime: Node.js 22 + TypeScript
- Framework: Express 4
- Database: SQLite (better-sqlite3)
- Orchestration: k3s Jobs (worker) + Deployment (API)
- Load generation: Pure Node.js HTTP with keep-alive

## Key Design Decisions

- **Domain verification required.** Anti-DDoS protection. Target must serve a verification file.
- **k8s Jobs for isolation.** Each test spawns Jobs on target nodes, cleaned up after completion.
- **RPS distributed evenly.** 1000 RPS across 4 nodes = 250 RPS each.
- **Percentile computation.** P50, P95, P99 latency from merged results.
- **No external load libraries.** Pure Node.js HTTP with keep-alive connections.

## Pricing

| Tier | RPS | Duration | Locations | Price |
|------|-----|----------|-----------|-------|
| Free | 100 | 1 min | 1 | $0 |
| Pro | 10,000 | 10 min | All 4 | $20/test USDC |
| Business | 100,000 | 60 min | All 4 | $100/test USDC |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3400` | API listen port |
| `DB_PATH` | `./data/loadtester.db` | SQLite path |
| `API_KEY` | — | Authentication key |
| `KUBECONFIG` | — | k8s config for Job creation |
| `WORKER_IMAGE` | `opsalis/loadtester-worker:latest` | Worker Docker image |

## Status

COMPLETE — Full implementation with API, worker, aggregator, k8s manifests, and website.

## Repository

https://github.com/opsalis/loadtester

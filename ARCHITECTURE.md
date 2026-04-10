# Architecture — LoadTester

## Overview

LoadTester is a distributed load testing service that generates traffic from 4 continents simultaneously using k3s infrastructure.

## System Components

### 1. API Server (Deployment)
- Single Express.js instance
- SQLite database for tests, metrics, and reports
- REST API for creating/managing tests
- Spawns k8s Jobs for test execution
- Aggregates results from workers

### 2. Worker (k8s Job)
- Spawned per test per region
- Pure Node.js HTTP client with keep-alive
- Configurable RPS, duration, ramp-up
- Reports per-second metrics back to API
- Self-terminates after test completion

### 3. Website (Cloudflare Pages)
- Static landing page
- Real-time test results dashboard

## Data Flow

```
1. Customer creates test via API (target URL, RPS, duration)
2. API verifies domain ownership (fetch verification file)
3. API spawns k8s Jobs on each target region node
4. Workers ramp up to target RPS
5. Workers report per-second metrics to API
6. API aggregates: merge latencies, compute percentiles
7. Test completes → workers terminate → Jobs cleaned up
8. Customer fetches full report via API
```

## Architecture Diagram

```
Client / CI Pipeline
       │
       ▼  REST (port 3400)
 ┌─────────────┐
 │  API Server  │  Express + SQLite
 │ (Deployment) │  Creates k8s Jobs
 └──────┬───────┘
        │  k8s Job API
   ┌────┼────┬────────┐
   ▼    ▼    ▼        ▼
 ┌────┐┌────┐┌────┐ ┌────┐
 │ CA ││ DE ││ UK │ │ SG │  Worker Pods (k8s Jobs)
 │ Job││ Job││ Job│ │ Job│  250 RPS each = 1000 total
 └────┘└────┘└────┘ └────┘
   │    │    │        │
   └────┼────┴────────┘
        ▼
   Target URL
```

## Domain Verification

Before any test executes, the API fetches:
```
https://{target-domain}/.well-known/loadtester-verify/{test-id}
```

The customer must serve this file at that path. This proves domain ownership and prevents DDoS abuse.

## Metrics Pipeline

Each worker reports per-second:
- `rps` — actual requests per second achieved
- `latency_avg` — average response time
- `latency_p50` — 50th percentile
- `latency_p95` — 95th percentile
- `latency_p99` — 99th percentile
- `errors` — error count
- `bytes` — bytes received
- `status_codes` — distribution of status codes

The aggregator merges these across all workers to produce:
- Global RPS (sum)
- Global percentiles (merged from sorted arrays)
- Error rate (errors / total requests)
- Throughput (total bytes / duration)

## Storage

SQLite with WAL mode:
- `tests` — test configuration, status, ownership
- `metrics` — per-second per-worker metrics
- `reports` — final aggregated report

## Security

- Domain verification prevents DDoS abuse
- API key authentication
- Rate limiting on test creation
- Maximum RPS caps per tier
- Tests auto-terminate at maximum duration

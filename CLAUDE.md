# CLAUDE.md — LoadTester

## What is LoadTester

Distributed global load tester. Consumers upload an ownership-verification file, then POST a test request. The master dispatches the job to a fleet of worker nodes worldwide. Workers run HTTP flood loops with keep-alive connections and report per-second metrics back. Results (RPS, p50/p95/p99 latency, error rate, throughput) are stored in SQLite and exposed via REST.

**Anti-DDoS principle:** before firing a single request, the master fetches `verification_file_url` from the target domain (same concept as Let's Encrypt domain validation). If the file is not reachable the test is refused. This is mandatory — no bypass.

## Relationship to Opsalis

This project runs ON the Opsalis network as an independent business. It uses Opsalis the same way any API owner would — registers services, earns USDC through the 95/5 settlement, runs in a Docker container. No changes to Opsalis core code required.

## Revenue Model

- Service fees paid in USDC via Opsalis settlement
- 5% IP royalty to Opsalis on every transaction (immutable, on-chain)
- 95% goes to the service operator
- Pricing: $1 (small), $3 (standard), $5 (large) per test

## Tech Stack

- **Runtime:** Node.js 22
- **Master:** Express 4, better-sqlite3, ws (WebSocket server), pure Node http/https
- **Worker:** ws (WebSocket client), pure Node http/https — no external load-testing library
- **Storage:** SQLite (master only, /data volume)
- **Transport:** Workers connect to master via WebSocket /ws; REST API on :4002

## Architecture

```
Client / CI pipeline
        │
        ▼  REST (port 4002)
  ┌─────────────┐
  │   Master    │  Express + SQLite + WebSocket
  └──────┬──────┘
         │  WebSocket /ws
    ┌────┴─────┐
    ▼    ▼     ▼
  Worker Worker Worker   (one per location/container)
```

## File Map

```
master/
  server.js         # Express REST API + WebSocket hub + SQLite storage (~250 lines)
  package.json      # express, better-sqlite3, ws
  Dockerfile        # node:22-alpine

worker/
  worker.js         # WS client + HTTP load runner + per-second metrics (~120 lines)
  package.json      # ws only
  Dockerfile        # node:22-alpine

website/
  index.html        # Landing page (hero, verification explainer, pricing, comparison)

docker-compose.yml  # master + worker-1 (us-east) + worker-2 (eu-west) + worker-3 (ap-southeast)
README.md
CLAUDE.md           # this file
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/tests` | Create + start a load test |
| `GET` | `/v1/tests` | List tests (last 100) |
| `GET` | `/v1/tests/:id` | Status + results |
| `GET` | `/v1/tests/:id/report` | Full structured report (PDF-ready) |
| `DELETE` | `/v1/tests/:id` | Cancel running test |
| `GET` | `/health` | Master health + worker count |
| `WS` | `/ws` | Worker connection endpoint |

## WebSocket protocol

**Master → Worker:**
```json
{ "type": "welcome", "worker_id": "uuid" }
{ "type": "load", "test_id": "uuid", "target_url": "...", "vus": 100, "duration_seconds": 60, "ramp_up_seconds": 6 }
{ "type": "cancel", "test_id": "uuid" }
```

**Worker → Master:**
```json
{ "type": "metrics", "test_id": "uuid", "rps": 182, "latency_avg": 22.1, "latency_p50": 18, "latency_p95": 87, "latency_p99": 210, "errors": 2, "bytes": 48200, "timestamp": 1711111111111, "location": "eu-west" }
{ "type": "complete", "test_id": "uuid", "location": "eu-west", "ts": 1711111171000 }
```

## SQLite Schema

Tables: `tests`, `metrics`, `results`. Master persists to `/data/loadtester.db` (Docker volume).

## DO NOT

- Remove the ownership verification gate — it is the anti-DDoS protection
- Add external load-testing libraries to the worker (keep it pure Node.js HTTP)
- Store credentials or API keys in any committed file
- Allow test creation without a `verification_file_url`

## Status

SKELETON BUILT — core architecture implemented, ownership verification wired, metrics pipeline complete. Not yet connected to Opsalis settlement.

## Repository

https://github.com/opsalis/loadtester

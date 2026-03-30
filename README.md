# LoadTester

Distributed global load tester. Website → Master server → Worker fleet.

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
  Worker Worker Worker   (one per location)
```

- **Master** accepts test requests, verifies ownership, dispatches work via WebSocket, aggregates metrics, stores results in SQLite.
- **Workers** receive load jobs, run HTTP floods with keep-alive connections, report per-second metrics back to master.

## Anti-DDoS ownership verification

Before any test starts, the master fetches `verification_file_url` from the target domain. If the file is not reachable the test is refused. This prevents LoadTester from being used as a DDoS tool against third-party targets.

## Quick start

```bash
# Start master + 3 workers
docker compose up --build

# Create a test
curl -X POST http://localhost:4002/v1/tests \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://api.example.com",
    "virtual_users": 100,
    "duration_seconds": 30,
    "locations": ["us-east", "eu-west"],
    "verification_file_url": "https://api.example.com/.well-known/verify-loadtest-TOKEN.txt"
  }'

# Check status
curl http://localhost:4002/v1/tests/<id>

# Get report
curl http://localhost:4002/v1/tests/<id>/report

# Cancel
curl -X DELETE http://localhost:4002/v1/tests/<id>
```

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/tests` | Create and start a load test |
| `GET` | `/v1/tests` | List all tests |
| `GET` | `/v1/tests/:id` | Get test status and results |
| `GET` | `/v1/tests/:id/report` | Full PDF-ready JSON report |
| `DELETE` | `/v1/tests/:id` | Cancel a running test |
| `GET` | `/health` | Master health check |
| `WS` | `/ws` | Worker connection endpoint |

### POST /v1/tests — request body

```json
{
  "target_url": "https://api.example.com",
  "virtual_users": 500,
  "duration_seconds": 60,
  "locations": ["us-east", "eu-west", "ap-southeast"],
  "verification_file_url": "https://api.example.com/.well-known/verify-loadtest-TOKEN.txt"
}
```

### GET /v1/tests/:id — response

```json
{
  "id": "uuid",
  "status": "finished",
  "target_url": "...",
  "virtual_users": 500,
  "duration_sec": 60,
  "results": {
    "total_requests": 28400,
    "total_errors": 12,
    "rps_avg": 473.3,
    "rps_peak": 512.1,
    "latency_p50": 18.4,
    "latency_p95": 87.2,
    "latency_p99": 210.5,
    "throughput_mb": 142.8,
    "worker_count": 3
  }
}
```

## Configuration

### Master environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4002` | HTTP listen port |
| `DB_PATH` | `/data/loadtester.db` | SQLite database path |

### Worker environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_URL` | `ws://master:4002/ws` | WebSocket URL of the master |
| `WORKER_LOCATION` | `default` | Location label reported in metrics |

## Scaling workers

Add more workers by duplicating a worker service in `docker-compose.yml` with a unique `WORKER_LOCATION`. Workers auto-reconnect on disconnect. Master distributes load across all connected workers.

## Development

```bash
# Master
cd master && npm install && node server.js

# Worker (in another terminal)
cd worker && npm install && MASTER_URL=ws://localhost:4002/ws node worker.js
```

## File structure

```
LoadTester/
  master/
    server.js         # Express + WebSocket master (250 lines)
    package.json
    Dockerfile
  worker/
    worker.js         # Load runner + WS client (120 lines)
    package.json
    Dockerfile
  website/
    index.html        # Landing page
  docker-compose.yml  # master + 3 workers
  CLAUDE.md
  README.md
```

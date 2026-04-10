# API Reference — LoadTester

Base URL: `https://api.loadtester.example.com`

## Authentication

All requests require `X-API-Key` header.

## Endpoints

### Health

```
GET /health
```

Response:
```json
{ "status": "ok", "version": "1.0.0", "total_tests": 42, "uptime": 86400 }
```

---

### Create Test

```
POST /v1/tests
```

Body:
```json
{
  "target_url": "https://your-domain.com/api/health",
  "rps": 5000,
  "duration_seconds": 300,
  "ramp_up_seconds": 10,
  "regions": ["americas", "europe-de", "europe-uk", "asia"],
  "tier": "pro"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `target_url` | string | Yes | — | URL to load test |
| `rps` | integer | No | 100 | Target requests per second |
| `duration_seconds` | integer | No | 60 | Test duration |
| `ramp_up_seconds` | integer | No | 5 | Ramp-up period |
| `regions` | string[] | No | all | Target regions |
| `tier` | string | No | `free` | `free`, `pro`, `business` |

Response `201`:
```json
{
  "id": "test-uuid",
  "target_url": "...",
  "rps": 5000,
  "status": "pending",
  "verification_url": "https://your-domain.com/.well-known/loadtester-verify/test-uuid",
  "message": "Serve any content at verification_url, then POST /v1/tests/{id}/start"
}
```

### Tier Limits

| Tier | Max RPS | Max Duration | Regions | Price |
|------|---------|-------------|---------|-------|
| free | 100 | 60s | 1 | $0 |
| pro | 10,000 | 600s | All 4 | $20 USDC |
| business | 100,000 | 3600s | All 4 | $100 USDC |

---

### Start Test

```
POST /v1/tests/:id/start
```

Triggers domain verification and starts load generation. Returns `403` if verification fails.

Response:
```json
{
  "id": "test-uuid",
  "status": "running",
  "rps_per_region": 1250,
  "regions": ["americas", "europe-de", "europe-uk", "asia"],
  "estimated_completion": "2026-04-09T12:05:00Z"
}
```

---

### List Tests

```
GET /v1/tests
```

Returns last 100 tests.

---

### Get Test + Metrics

```
GET /v1/tests/:id
```

Returns test details with per-second per-region metrics.

---

### Get Report

```
GET /v1/tests/:id/report
```

Returns aggregated report. Only available after test completes.

```json
{
  "test": { "..." },
  "report": {
    "total_requests": 1500000,
    "total_errors": 180,
    "avg_rps": 5000.00,
    "avg_latency": 34.21,
    "p50_latency": 22.40,
    "p95_latency": 87.10,
    "p99_latency": 210.50,
    "max_latency": 1200,
    "total_bytes": 750000000,
    "error_rate": 0.01
  }
}
```

---

### Cancel Test

```
DELETE /v1/tests/:id
```

Cancels a running or pending test.

---

## Domain Verification

Before starting any test, you must prove domain ownership:

1. Create test via `POST /v1/tests` — response includes `verification_url`
2. Serve any content at that URL on your domain
3. Call `POST /v1/tests/:id/start` — we fetch the verification URL
4. If accessible, test starts. If not, `403` error.

The verification URL format:
```
https://{your-domain}/.well-known/loadtester-verify/{test-id}
```

This prevents using LoadTester as a DDoS tool.

## Error Responses

```json
{ "error": "Description of what went wrong" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request |
| 401 | Invalid API key |
| 403 | Domain verification failed |
| 404 | Test not found |
| 500 | Internal error |

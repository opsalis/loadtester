# LoadTester — Distributed Load Testing from 4 Continents

Load test your APIs and websites with real-world traffic from Canada, Singapore, Frankfurt, and the UK simultaneously.

## Features

- **Multi-continent load generation** — Traffic from 4 continents simultaneously
- **Pay per test** — No monthly subscriptions
- **Domain verification** — Anti-DDoS protection built-in
- **Real-time metrics** — P50, P95, P99 latency, error rate, throughput
- **Configurable patterns** — Ramp-up, steady state, spike testing
- **API-first** — Integrate into CI/CD pipelines

## Quick Start

```bash
# 1. Create a verification file on your domain
# Serve: https://your-domain.com/.well-known/loadtester-verify/{test-id}

# 2. Create a load test
curl -X POST http://localhost:3400/v1/tests \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-key' \
  -d '{
    "target_url": "https://your-domain.com/api/health",
    "rps": 1000,
    "duration_seconds": 300,
    "regions": ["americas", "europe", "asia"]
  }'

# 3. Check results
curl http://localhost:3400/v1/tests/{test-id} \
  -H 'X-API-Key: your-key'

# 4. Get full report
curl http://localhost:3400/v1/tests/{test-id}/report \
  -H 'X-API-Key: your-key'
```

## Architecture

```
API Server (Deployment)
┌────────────────────┐
│ Express + SQLite    │  Creates k8s Jobs per test
│ REST API :3400      │
└────────┬───────────┘
    k8s Jobs spawned on each region
┌────────┼────────┬──────────┐
│ CA     │ DE     │ UK       │ SG
│ 250rps │ 250rps │ 250rps   │ 250rps
└────────┴────────┴──────────┘
         → Target URL
```

## Deployment

```bash
kubectl apply -f backend/k8s/service.yaml
kubectl apply -f backend/k8s/deployment.yaml
```

## Pricing

| Tier | RPS | Duration | Locations | Price |
|------|-----|----------|-----------|-------|
| Free | 100 | 1 min | 1 | $0 |
| Pro | 10,000 | 10 min | All 4 | $20/test USDC |
| Business | 100,000 | 60 min | All 4 | $100/test USDC |

## License

Proprietary — Mesa Operations LLC

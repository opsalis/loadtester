# CLAUDE.md — LoadTester

## What is LoadTester
Distributed Global Load Tester — 500-node coordinated traffic burst

## Relationship to Opsalis
This project runs ON the Opsalis network as an independent business.
It uses Opsalis the same way any API owner would — registers services,
earns USDC through the 95/5 settlement, runs in a Docker container.
No changes to Opsalis core code required.

## Revenue Model
- Service fees paid in USDC via Opsalis settlement
- 5% IP royalty to Opsalis on every transaction (immutable, on-chain)
- 95% goes to the service operator

## Tech Stack
- Docker container (Node.js or Go)
- Connects to Opsalis wrapper as a local API server
- Registers services via wrapper web console
- Settlement via Opsalis smart contracts on Base

## Status
IDEATION — not started yet.

## Repository
https://github.com/opsalis/loadtester

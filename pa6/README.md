# PA6 — Contract-first checkout API and hand-rolled saga

This folder contains the TypeScript checkout orchestrator, four mock downstream services, the OpenAPI contract, Spectral rules, and the public tests for Session 6.

## Run

From this directory, with Docker Compose and Node.js 20+ installed:

```sh
docker compose run --rm spectral
docker compose up -d --build --wait
npm --prefix tests/public install
npm test
docker compose exec orchestrator npx tsc --noEmit
```

The orchestrator listens on port 3000. The mock services listen on 4001–4004. The checkout API accepts a canonical order and requires an `Idempotency-Key` header.

## Contract-first history

The first PA6 commit adds `openapi.yaml` before `orchestrator/src/server.ts` was implemented. Run Spectral from this directory with `docker compose run --rm spectral`.

## Saga sequence

1. Authorize payment using an amount derived from integer cents.
2. Reserve inventory.
3. Create shipping.
4. Send notification to `customer.email`.

Calls are sequential and individually time-limited. If a later call fails, inventory and then payment are compensated in reverse completion order. A failed compensation produces `compensation_failed`.

Idempotency records and saga traces are stored in `orchestrator/data/` and survive container restarts. Downstream URLs and the timeout are configured through environment variables in `docker-compose.yml`.

See `docs/adr-005.md` for the architectural decisions and trade-offs.

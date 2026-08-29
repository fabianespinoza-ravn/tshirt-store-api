# T-Shirt Store API

A NestJS REST API for a t-shirt store: authentication with roles, product catalog
with variants and images, carts, orders and Stripe payments. Built on the ERD and
the OpenAPI contract designed in the previous weeks of the Ravn NodeJS program.

## Architecture

![Production architecture](docs/diagram.png)

The one-page write-up — the queue decision, the deploy shape and what to monitor —
is in [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md). Request-level sequence
diagrams for every flow live in [`docs/flujos/`](docs/flujos/).

## What is implemented

| Area | State |
|---|---|
| Authentication | Sign up, email verification, sign in, refresh rotation, sign out, password reset and change |
| Authorization | CASL abilities, policy guard, roles for client, manager and delivery |
| Catalog | Categories, products, SKUs and images, with S3-backed storage |
| Cart, orders, payments | Designed in the contract, not yet implemented |

Unit tests cover the services: **11 suites, 115 tests**.

## Requirements

- Node.js 20 or newer
- Docker, for PostgreSQL, Redis and MinIO

## Getting started

```bash
npm install
cp .env.example .env          # fill in the values
docker compose up -d          # PostgreSQL, Redis, MinIO
npx prisma migrate deploy
npm run start:dev
```

Swagger UI is served at `/docs` once the application is running.

## Testing

```bash
npm run lint
npm run build
npx jest                      # unit tests
npx jest --coverage           # with coverage
```

## Project layout

```
src/
  auth/       authentication, CASL abilities and guards
  catalog/    categories, products, SKUs and images
  common/     problem-details errors, pagination, decorators
  config/     environment validation at bootstrap
  mail/       outbound mail
  prisma/     database access
  storage/    S3-compatible object storage
  testing/    unit-test harness and factories
prisma/       schema, migrations and raw SQL notes
docs/         architecture write-up and flow diagrams
```

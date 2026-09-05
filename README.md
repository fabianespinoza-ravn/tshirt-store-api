# T-Shirt Store API

A NestJS REST API for a t-shirt store: authentication with roles, product catalog
with variants and images, carts, orders and Stripe payments. Built on the ERD and
the OpenAPI contract designed in the previous weeks of the Ravn NodeJS program.

## Architecture

![Production architecture](docs/diagram.png)

### Queue

- **BullMQ over the Redis already in the runtime** — retries, priorities and delayed jobs inside Nest, without adding a broker for a single service.
- **Retry policies that differ by what the job carries, not by house style.** Payment settlement retries with backoff for close to a day and keeps its failures indefinitely, because there is no attempt count after which losing a payment is acceptable and its payload is only a Stripe identifier. Mail gets three attempts and then **keeps nothing** — its payload holds a one-time token the database deliberately stores only the hash of, so a retained failure would be a live credential sitting in Redis. Its diagnosis is a log line carrying the recipient and the error and never the body. The sweep does not retry at all: it runs again in a minute, and a second attempt would put two sweeps over the same expired orders.
- **Redis earns its place twice**: the rate-limit counters live there too, because an in-process limiter multiplies its own limit by the number of API instances behind the load balancer.
- **The webhook is acknowledged, not settled.** The API verifies the signature, records the event and answers; the worker moves the order afterwards, so an order can read `PENDING` for a moment after its payment succeeded.
- **Checkout reserves before it charges.** Stock reservation and the `PENDING` order come first. If Stripe times out before returning a `clientSecret`, the order stays `PENDING` with no payment attempt and the repeatable sweep cancels the intent and releases the stock.

### Deployment

- **One container image, two entrypoints.** Shared build and pipeline, but each process scales on its own signal: request latency for the API, queue depth for the worker. `Dockerfile` builds it; `render.yaml` runs `node dist/main` for the web service and `node dist/worker` for the worker.
- **The schema syncs once as a release step**, never on boot, so instances never race to sync it. No migration history is kept: `prisma migrate diff` plans the SQL, the step refuses a plan that drops or narrows anything unless one deploy is explicitly allowed to, and `prisma db execute` applies it as one transaction.
- **Expand and contract.** The compatible change ships first and the old shape is dropped in a later release — a rollback is just redeploying the previous tag from the registry, and there's no migration history to roll back through either way. The `live_email`/`live_user_id` change is the one exception: nothing had been deployed yet, so it ships in a single release.
- **Pooling is a constraint, not a detail.** Prisma pools inside each Node process, so there is no shared pooler and open connections grow with the number of processes, not with traffic.
- **The pool size is pinned on the database URL**, not left to Prisma's CPU-derived default, which reads the host's cores rather than the container's quota. The ceiling is PostgreSQL's `max_connections`, and it has to hold during a rolling deploy, when old and new instances are briefly up at once.

### Monitoring

Four domain alerts a generic dashboard would not catch:

- Webhook events recorded but **not settled for more than N minutes**.
- **Depth and age of the settlement dead-letter queue.**
- Orders still `PENDING` past `expires_at` — meaning **the sweep is not running**.
- `SUCCEEDED` payments on `CANCELLED` orders with no `stripe_refund_id` — **money taken and not returned**.

On the generic base underneath: error rate and p95 per route, pool saturation seen as Prisma's pool-timeout errors, queue depth and job age, and structured JSON logs with a correlation id and customer data redacted from webhook payloads.

The full write-up is in [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md). Request-level
sequence diagrams for every flow live in [`docs/flows/`](docs/flows/).

## What is implemented

| Area | State |
|---|---|
| Authentication | Sign up, email verification, sign in, refresh rotation, sign out, password reset and change |
| Authorization | CASL abilities, policy guard, roles for client, manager and delivery |
| Catalog | Categories, products, SKUs and images, with S3-backed storage |
| Cart and likes | One active cart per client, lines added, updated and removed, and the product like |
| Orders, payments | Designed in the contract, not yet implemented |

Unit tests: **20 suites, 172 tests**.

## Requirements

- Node.js 20 or newer
- Docker, for PostgreSQL, Redis and MinIO

## Getting started

```bash
npm install
cp .env.example .env          # fill in the values
docker compose up -d          # PostgreSQL, Redis, MinIO
npm run prisma:sync           # plan, guard and apply the schema, then the backfill
npm run start:dev
```

Swagger UI is served at `/docs` once the application is running.

## Testing

```bash
npm run lint
npm run build
npx jest                      # unit tests
npx jest --coverage           # with coverage
npm run test:e2e              # end to end, over a real tshirt_store_test database on the compose Postgres
```

The end-to-end suite needs `docker compose up -d` first. It creates the test
database if it is missing, syncs it to `schema.prisma`, and truncates every
table before each test; it never reads `.env` or touches the development
database. Only `MailService` (which has no transport) and the rate limiter's
counters are replaced, so a test can read the one-time tokens and reset the
counters — everything else is the production wiring.

## Project layout

```
src/
  auth/         authentication, CASL abilities and guards
  catalog/      query fragments and response views shared by the four catalog modules
  categories/   categories
  common/       problem-details errors, pagination, decorators
  config/       environment validation at bootstrap
  images/       product images
  mail/         outbound mail
  prisma/       database access
  products/     products
  skus/         SKUs
  storage/      S3-compatible object storage
  testing/      unit-test harness and factories
prisma/         schema and the one-time live-column backfill
docs/           architecture write-up and flow diagrams
Dockerfile      the production image: one build, both entrypoints
render.yaml     the Render blueprint that deploys it
```

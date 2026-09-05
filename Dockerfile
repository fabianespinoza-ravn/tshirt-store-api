# Production image for tshirt-store-api.
#
# One image, two entrypoints: `node dist/main` runs the API and
# `node dist/worker` runs the queue worker, which is what render.yaml declares
# as the `dockerCommand` of each service and what the Deployment section of
# docs/ARQUITECTURA.md describes. Build and pipeline are shared; only the
# command differs, so the two processes can never drift apart.
#
# Node 24 is the version .github/workflows/ci.yml verifies against, and
# package.json declares no `engines` range, so CI is the only statement of
# what this project targets.

ARG NODE_IMAGE=node:24-alpine

# --------------------------------------------------------------------- deps
# Every dependency, dev included: the build needs the Nest CLI, the TypeScript
# compiler and the Prisma CLI. None of this layer reaches the final stage.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# -------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The generated client is not versioned and nothing runs without it. An image
# built without this step still builds — the failure moves to runtime, where
# `@prisma/client` throws on import because it was never initialised, which is
# the worst place to find out. Generating it here also pins the query engine
# to this image's platform instead of to whatever machine last ran an install.
RUN npx prisma generate

# `build` emits the two Nest entrypoints under dist/; `build:deploy` emits the
# pre-deploy scripts under dist-deploy/ so the final stage needs no ts-node.
RUN npm run build && npm run build:deploy

# A build can succeed while emitting an entrypoint somewhere else — widening
# tsconfig's `include` past src/ moves dist/main.js to dist/src/main.js — and
# the deploy would then build cleanly and never start. CI checks the same two
# paths for the same reason; this checks them again where the image is made,
# together with the two files render.yaml's preDeployCommand runs.
RUN test -f dist/main.js \
  && test -f dist/worker.js \
  && test -f dist-deploy/sync-schema.js \
  && test -f dist-deploy/backfill-live-columns.js

# ------------------------------------------------------------------ runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. The Prisma CLI comes with them: package.json
# lists `prisma` under devDependencies, but @prisma/client declares it as a
# peer dependency, so package-lock.json resolves it into the production tree
# and `--omit=dev` keeps it. That is what lets render.yaml's preDeployCommand
# run `prisma migrate diff` and `prisma db execute` from inside this image
# without any of the devDependencies proper.
#
# `--ignore-scripts` skips two postinstalls that would both be wasted work
# here: @prisma/client regenerating a client this stage copies in, and
# @prisma/engines downloading binaries the build stage already has.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The generated client and the engine binaries, from the stage that ran
# `prisma generate` with the scripts enabled. Nothing else is copied out of
# the build stage's node_modules, so no devDependency crosses over.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-deploy ./dist-deploy

# The pre-deploy step reads the datasource URL the way the Prisma CLI always
# does, from schema.prisma's env("DATABASE_URL"), so the schema has to ship.
COPY prisma/schema.prisma ./prisma/schema.prisma

# The pre-deploy step is the one thing in this image that fails at deploy
# time rather than at boot, so it is proven here instead: this resolves the
# CLI, loads the query engine and the schema engine, and reads the schema.
RUN node node_modules/prisma/build/index.js --version

# The image ships nothing that needs to be written or owned by root.
USER node

# Documentation only; Render injects PORT and main.ts binds to it.
EXPOSE 3000

# The default is the API. render.yaml overrides it with `node dist/worker`
# for the worker service.
CMD ["node", "dist/main"]

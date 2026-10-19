# One image, every shape — in two variants.
#
# Which products a container runs is LISTEN_FIRE_PRODUCTS at RUN time, not a build
# choice (D14, D30(d)) — so `asks` and the full composition are the same bytes
# with a different environment. Building a separate image per product would
# make the composition a fork, which is the thing the carve is undoing.
#
# The two variants differ in exactly one thing, Chromium, which only the
# browser-rendered document fetches (DocSend, Papermark, Notion, ...) and PDF
# rendering use:
#   api-browser  the LAST stage, so a plain `docker build` makes it. Today's
#                image, published as ghcr.io/listen-fire/api.
#   api-slim     no Chromium; several hundred MB smaller, so a cold start pulls
#                less. Published as ghcr.io/listen-fire/api-slim. A feature that
#                needs a browser fails naming the browser variant.
# Both carry production dependencies only: the compiler and its toolchain stay
# in the build stage.
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f deploy/Dockerfile -t listen-fire-api .
#   docker build -f deploy/Dockerfile --target api-slim -t listen-fire-api-slim .
# The compose file here already says so.

FROM node:22.20.0-slim AS base

# psql: the migration runner is a shell script over src/db/migrations/*.sql.
# curl: the compose healthcheck. openssl: Prisma's engine needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate

WORKDIR /srv/listen-fire

# Manifests first, so editing source does not re-run the install. The frontends
# are deployed separately (they are Next apps); this image is the API and its
# workers, so only the api's own workspace closure is installed. One list,
# shared by the build stage (all dependencies) and the runtime stage (production
# ones), so the two cannot drift.
FROM scratch AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/principal/package.json packages/principal/
COPY packages/file-text/package.json packages/file-text/
COPY packages/model-providers/package.json packages/model-providers/
COPY modules/anthropic/package.json modules/anthropic/
COPY modules/judge-llm/package.json modules/judge-llm/
COPY packages/module-kit/package.json packages/module-kit/
COPY modules/dealroom/package.json modules/dealroom/
COPY modules/granola/package.json modules/granola/
COPY modules/evertrace/package.json modules/evertrace/
COPY modules/dropbox/package.json modules/dropbox/
COPY modules/google-sheets/package.json modules/google-sheets/
COPY modules/google-drive/package.json modules/google-drive/
COPY modules/gmail/package.json modules/gmail/
COPY modules/web/package.json modules/web/
COPY modules/affinity/package.json modules/affinity/
COPY modules/airtable/package.json modules/airtable/
COPY modules/attio/package.json modules/attio/
COPY modules/telegram/package.json modules/telegram/
COPY modules/slack/package.json modules/slack/
COPY packages/engine-contracts/package.json packages/engine-contracts/
COPY packages/movement-engine/package.json packages/movement-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/movement-lang/package.json packages/movement-lang/
COPY packages/story-view/package.json packages/story-view/

# ---- build: every dependency, the compiler, the source. Never shipped. ----
FROM base AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=manifests / ./
RUN pnpm install --frozen-lockfile --filter api...

COPY . .

WORKDIR /srv/listen-fire/apps/api
RUN pnpm prisma generate

# The compiled artifact. Nothing here runs ts-node: `principal` and
# `engine-contracts` are vendored into the api's own build output by this step
# (see each package's tsconfig.build.json), which is what makes
# `node build/server.js` resolvable.
ARG BUILD_HEAP_MB=6144
RUN NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB} pnpm build

# `#shared/...` is imported by path and resolves to packages/shared, whose
# build emits its .js beside the .ts, in place. That emitted tree is runtime
# code; its node_modules is not (the deploy stage resolves its own).
RUN mkdir /runtime-shared \
  && find /srv/listen-fire/packages/shared -mindepth 1 -maxdepth 1 ! -name node_modules -exec cp -a {} /runtime-shared/ \;

# ---- deploy: the api's production dependency tree, and nothing else. ----
# `pnpm install --prod` is not enough here: the root manifest depends on the web
# app (for dependabot), so a filtered install still pulls Next and its toolchain
# into the virtual store. `deploy` resolves only the api's own closure.
FROM base AS deploy
COPY --from=manifests / ./
RUN pnpm --filter api deploy --prod /deploy

# ---- api-slim: production dependencies + the compiled artifact. ----
FROM base AS api-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /srv/listen-fire/apps/api

# The api's own tree (migrations, the prisma schema, the migrate script), its
# production node_modules, and the compiled output. The other workspace packages
# are already inside build/node_modules, vendored by the build.
COPY --from=deploy /deploy/ ./
COPY apps/api ./
COPY --from=build /srv/listen-fire/apps/api/build ./build
COPY --from=build /srv/listen-fire/apps/api/public ./public

# `deploy` copies a workspace package as `npm pack` would (shared's "files" is
# just dist/), but `#shared/...` is imported by path and needs the .js its build
# emitted beside the .ts. Put that tree over the copy.
COPY --from=build /runtime-shared /tmp/runtime-shared
RUN cp -a /tmp/runtime-shared/. "$(readlink -f node_modules/#shared)/" && rm -rf /tmp/runtime-shared

# Secrets live in the `listen-fire-config` volume, not in the image and not in an
# env_file the docker CLI would have to read off the host. Every service sources
# them through this one wrapper.
COPY deploy/init/with-generated-env.sh /usr/local/bin/with-generated-env
RUN chmod +x /usr/local/bin/with-generated-env

RUN pnpm prisma generate

# The release this image IS. A tag build passes it (the release workflow does);
# a build from a tree nobody tagged is `dev`. Declared here, after the build, so
# changing it re-runs nothing but these last layers. The process reads it back
# out of the environment and reports it on /healthz/workers and in the UI.
ARG LISTEN_FIRE_VERSION=dev
ENV LISTEN_FIRE_VERSION=${LISTEN_FIRE_VERSION}
# Read by the browser-using features, which then name the other variant.
ENV LISTEN_FIRE_IMAGE_VARIANT=slim

LABEL org.opencontainers.image.vendor="Listen-Fire" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/listen-fire/listen-fire"
ENV NODE_ENV=production
ENV TZ=UTC
ENV PORT=3000
EXPOSE 3000

# Migrations are a separate one-shot service in the compose file
# (`pnpm schema:migrate`), so a restart never races the schema.
CMD ["node", "build/server.js"]

# ---- api-browser: the slim image plus Chromium. The default (last) stage. ----
FROM api-slim AS api-browser
# Chromium for the browser-rendered document fetches (DocSend, Papermark,
# Notion) and PDF rendering. Installed through the api's own playwright so the
# browser build matches the lockfile's version. The skip flag above only guards
# the install step, so it is cleared for this one command. A fixed path keeps
# the browser findable by whatever user the container runs as.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV LISTEN_FIRE_IMAGE_VARIANT=browser
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 pnpm exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

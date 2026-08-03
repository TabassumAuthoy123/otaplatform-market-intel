# ============================================================================
#  OTA Platform — Market Intelligence  ·  production image
#  Multi-stage so the final image carries no dev dependencies.
#  Runs on port 3000 — deliberately clear of OTAPlatform's 8080 / 8081 / 3306.
#
#  content/ IS NOT BAKED IN — see the note on the runner stage. It is a bind
#  mount, because the admin portal writes those same files from the host.
# ============================================================================

# ---- 1. install dependencies ----------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- 2. build --------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 3. run ----------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Inside the container this must be 0.0.0.0 or Docker cannot route to the
# process. The port is published on 127.0.0.1 in docker-compose.yml, so the app
# is still not on the network — that restriction belongs at the published port,
# not here.
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# There is no public/ directory in this project — every asset is inlined or comes
# out of content/site.json. The line that used to copy it,
#   COPY --from=builder /app/public ./public
# failed with "/app/public: not found", which means this image had never once
# built, while README and DOCKER.md both documented `docker compose up --build`
# as the way to run it. The app compiled fine; the failure was two steps later,
# so nothing short of running the build would have shown it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The JSON store is a bind mount, not part of the image.
#
# Every loader resolves content/ from process.cwd(), and a standalone build does
# not carry arbitrary data directories — so a container without this mount starts
# cleanly and then fails on every page with no accounting book. Baking a COPY of
# content/ in would be worse: the admin portal runs on the host and writes those
# same files, so the container and the portal would drift apart with nothing to
# show it. docker-compose.yml mounts ./content here.
RUN mkdir -p /app/content && chown nextjs:nodejs /app/content

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:3000/api/agencies?stats=1" || exit 1

CMD ["node", "server.js"]

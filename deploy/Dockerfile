# Sakshi images. Build on a connected machine, then move them across the air gap with
# `docker save` / `docker load` (see deploy/package-offline.sh). Nothing is fetched at runtime.

# ---------- dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- web build
FROM deps AS build
COPY . .
RUN rm -rf data && npm run build

# ---------- web gateway (standalone Next.js server)
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 SAKSHI_DATA=/data NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- validator node / setup ceremony
FROM node:22-bookworm-slim AS validator
WORKDIR /app
ENV SAKSHI_DATA=/data NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/lib/core ./src/lib/core
COPY ledger ./ledger
COPY scripts/setup.ts ./scripts/setup.ts
USER node
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["ledger/node.ts", "--id", "v1"]

# ---------- watermark engine
FROM python:3.12-slim AS wm
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY wm-engine/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY wm-engine/*.py ./
# Same uid as the node images (1000) so it can read the 0600 secrets written by setup.
RUN useradd -r -u 1000 wm
USER wm
EXPOSE 7200
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7200", "--timeout-keep-alive", "75", "--log-level", "warning"]

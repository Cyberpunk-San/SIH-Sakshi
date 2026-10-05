<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Sakshi project notes

PQ forensic-watermark document distribution: Next.js gateway (`src/`), 4 BFT validators (`ledger/node.ts`), Python watermark engine (`wm-engine/`). Overview in `README.md`, Docker/cloud/air-gap guide in `DEPLOY.md`. Keep both in sync when commands, ports or env vars change.

- Local stack: `npm run setup` → `npm run build` → `npm run stack` (web :3000, validators :7101-7104, wm :7200, data in `data/`).
- Docker stack: `docker compose build` → `docker compose run --rm setup` → `docker compose up -d` (data in `docker-data/`, web port `SAKSHI_PORT`, default 3000). Docker Desktop must be running.
- Tests: `npm test` (core + live ledger), `npm run test:wm` (21 pytest), `npm run e2e` (32 checks; needs a running stack and `<data>/bootstrap/`; `SAKSHI_URL` / `SAKSHI_DATA` select the target), `npm run tamper-demo`.
- `data/`, `docker-data/` and `demo/` hold private keys and are git-ignored; never commit them.

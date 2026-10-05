# Sakshi (साक्षी, "witness")

**Forensic, post-quantum document distribution for air-gapped networks.** A sender encrypts a document once for a group. Each recipient decrypts it with their own credentials. Every decrypted copy looks identical but carries an invisible watermark unique to that decryption session. The recipient signs each decryption record with their own ML-DSA-65 key, and a quorum of independent validators commits it to a permissioned ledger. Given a leaked copy, Sakshi recovers the watermark, finds the record, and produces a self-contained evidence bundle that anyone can verify offline.

Built on the same ideas as [SIH-Dharma / ExamGuard](../SIH-Dharma): AES content encryption, keys wrapped per person, threshold release, chunked and jumbled storage, a hash-chained signed audit trail, and leak attribution. The difference is that every primitive here is post-quantum and every component runs offline.

---

## Requirement coverage

| Requirement | How Sakshi meets it |
|---|---|
| Unique invisible watermark at the moment of decryption | Keyed spread-spectrum watermark embedded by the gateway **after** the decryption record is committed. Payload = 64-bit `wmId` + Reed-Solomon parity. |
| Specific to recipient **and** session | `wmId = H(docId, recipientId, sessionId)`. A new random session id on every open, so the same person opening twice gets two different marks. |
| Visually identical, forensically distinct | Perceptually masked amplitude: zero-mean change > 38 dB PSNR. Copies differ byte-wise and in their hidden payload. |
| Decryption bound to identity with the recipient's own private key | The `DECRYPT` record is signed **in the recipient's browser** with ML-DSA-65. The server never sees private keys. The recipient also signs an `ACK` with the SHA-256 of the exact file received. |
| NIST post-quantum for key exchange and signatures | **ML-KEM-768 (FIPS 203)** for every key wrap. **ML-DSA-65 (FIPS 204)** for every signature: user records, registrar certificates, validator votes, gateway deliveries, logins, evidence attestation. No RSA, ECDH or ECDSA anywhere. |
| Immutable audit layer on blockchain/DLT | Permissioned BFT ledger with 4 validators. A block is final only with ≥ 3 ML-DSA-65 validator signatures (a quorum certificate). Blocks are hash-chained, and transactions are committed under a Merkle root. |
| No single admin or compromised account can alter or erase records | Changing a record breaks its block hash, and re-certifying needs a quorum of validator private keys. Validators re-verify their own files every 5 s, quarantine tampered files as evidence, and restore from the certified copy (see `npm run tamper-demo`). |
| Extract watermark → ledger lookup → verifiable record | `/forensics` and `POST /api/forensics`: blind extraction (crop, zoom 0.33–3×, JPEG), `wmId → DECRYPT` index, then a full evidence bundle with Merkle proofs and validator certificates. Verified again in the investigator's browser and by `npm run verify-evidence`. |
| Fully offline / air-gapped, no cloud KMS, no public chain | Keys are generated in the browser and stored as Argon2id-encrypted key files. The ledger and watermark engine run on the LAN. No WebCrypto dependency (works on plain-HTTP LAN), no web fonts, and a CSP of `default-src 'self'`. |

## Architecture

```
                 ┌──────────────────── air-gapped LAN ─────────────────────┐
  Browser (sender / recipient / investigator / registrar)
   • ML-KEM-768 + ML-DSA-65 keys, generated locally, Argon2id-locked .sakshikey
   • encrypts documents, signs every record, re-verifies evidence
        │ HTTPS/HTTP (same origin only)
        ▼
  Web gateway (Next.js)                       Watermark engine (Python, loopback/internal)
   • relays signed tx, fail-closed pipeline ──► embed + self-check / blind extract
   • jumbled chunk vault (+ decoys)
   • holds K_R only in RAM, per session
        │ signed share-release requests          ▲ K_G shares sealed to gateway ML-KEM key
        ▼                                          │
  Validators v1..v4 (permissioned BFT, quorum 3/4) ─┘
   • rotating leader, one vote per height, ML-DSA-65 quorum certificates
   • deterministic state machine: certificates, documents, decryptions, deliveries, receipts, queries
   • each holds one Shamir share of every document's K_G
```

### Key hierarchy (broadcast-encrypt, individually-decrypt)

```
DEK = HKDF(K_R ‖ K_G, docId)
 ├─ K_R  same for all recipients, sealed separately to each recipient (ML-KEM-768 + AES-GCM)
 └─ K_G  Shamir 3-of-4, one share sealed to each validator's ML-KEM key
file      → AES-256-GCM(K_file)            ciphertext hash on the ledger
ciphertext→ 64 KiB fixed-size frames, each AES-GCM(K_chunk, aad=docId‖i),
            stored as HMAC(K_name, docId‖i).blob among random decoys, shuffled, random mtimes
```

No single party can produce plaintext:
- **The recipient** alone has only `K_R`, so they cannot obtain an unwatermarked copy.
- **The gateway** gets `K_R` only sealed to a specific committed record, and needs 3 validator shares.
- **Validators** release a share only for a committed, unexpired, undelivered `DECRYPT` record, and only once.
- **An admin** with the vault sees indistinguishable blobs with no names, order or count.

### Decryption flow (fail-closed)

1. Recipient unwraps `K_R` with their ML-KEM key in the browser.
2. Recipient signs `DECRYPT {docId, recipientId, sessionId, wmId, ctSha256, at}` with ML-DSA-65.
3. `K_R` is sealed to the gateway's ML-KEM key, bound to that record's tx id.
4. The gateway commits the record, so a quorum of validators witness it **before** any plaintext exists.
5. Validators check the committed record and release `K_G` shares, sealed to the gateway.
6. The gateway reassembles the chunks, checks the Merkle root and ciphertext hash, and decrypts in RAM.
7. The watermark is embedded and **read back**. If the self-check fails, nothing is delivered.
8. A gateway-signed `DELIVERY {wmId, deliveredSha256}` is committed, and the file is returned.
9. The recipient signs an `ACK` over the hash of exactly the bytes received.

### Watermark

- **Layout:** a 128×128 tile of 4-px chips, repeated across the page. A keyed pilot pattern handles blind alignment, polarity and zoom recovery. The zoom factor is estimated from tile periodicity in the autocorrelation.
- **Payload:** 64-bit id + 8 RS parity bytes = 128 bits, about 2,000 chips per bit on an A4 page.
- **PDF:** *preserve* keeps vector text and adds a darkening-only overlay on a 100-dpi grid. *Flatten* bakes the mark into 200-dpi page rasters.
- **Confidence:** reported as a σ score with a false-match probability. Below 6σ (p < 10⁻⁹) the result is reported as no attribution.

Measured in tests: exact copies, screenshots of PDF pages at 72/96/144 dpi, cropped and 1.3×-zoomed page captures, 0.6×–2× rescaled images, and JPEG at quality 65–70 all attribute correctly (~10–11σ). Unmarked files and wrong keys return nothing.

## Quick start (single machine)

Requirements: Node ≥ 20.19, Python ≥ 3.11.

```bash
npm install
pip install -r wm-engine/requirements.txt
npm run setup            # creates data/: genesis, validator/gateway keys, registrar key + passphrase
npm run build
npm run stack            # 4 validators + watermark engine + web on :3000
```

1. Open `http://localhost:3000/login` and import `data/bootstrap/registrar.sakshikey` with the passphrase printed by setup. Then delete `data/bootstrap`.
2. Users enrol at `/enrol`. Keys are generated in their browser, and a `.sakshikey` file is downloaded.
3. The registrar approves them at `/admin`, which signs a certificate onto the ledger.
4. Senders use `/send`, recipients use `/inbox`, investigators use `/forensics`, and everyone can see `/ledger`.

`npm run stack:dev` runs the same stack with `next dev`.

## Quick start (Docker)

Requirements: Docker Desktop (or Docker Engine with the Compose plugin). Nothing else is needed on the host.

```bash
docker compose build                 # sakshi-web, sakshi-validator, sakshi-wm
docker compose run --rm setup        # once: creates docker-data/ (genesis, keys, registrar)
docker compose up -d                 # 4 validators + watermark engine + web on :3000
```

If port 3000 is taken, publish on another port with `SAKSHI_PORT=3100 docker compose up -d`, or put `SAKSHI_PORT=3100` in a `.env` file next to `docker-compose.yml`. The registrar key is in `docker-data/bootstrap/`. [DEPLOY.md](DEPLOY.md) covers the full Docker guide: first sign-in, everyday commands, a cloud demo server with HTTPS, backups and troubleshooting.

## Air-gapped deployment

```bash
# connected build machine
sh deploy/package-offline.sh                     # → sakshi-offline.tar (+ .sha256)
# offline host
tar xf sakshi-offline.tar && cd sakshi-offline
docker load -i images.tar
mkdir -p docker-data && sudo chown 1000:1000 docker-data   # containers run as uid 1000
docker compose run --rm setup && docker compose up -d
```

For multiple sites, run `npm run setup -- --hosts 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.14 --force` on an offline ceremony machine. Give each validator operator only `data/nodes/<id>` and `data/secrets/<id>.pass`, plus the public `data/genesis.json`.

## Verification

| Command | What it proves |
|---|---|
| `npm test` | Crypto core (Shamir, Merkle, ML-KEM sealing, broadcast encryption, swapped-chunk detection, Argon2id key files). Plus a live 4-node ledger: commits at 4/4 and 3/4, halts safely at 2/4 and recovers, rejects forged signatures, a node tampered with while offline detects it and heals from peers, and a node killed mid-write (torn state files and chain line) restarts and heals. |
| `npm run test:wm` | 21 watermark robustness tests (images and both PDF modes). |
| `npm run e2e` | 32 checks against the running stack: enrolment, group distribution, per-session marks, non-recipient refusal, 5 leak scenarios attributed, evidence tamper detection, offline verifier, revocation. |
| `npm run tamper-demo` | Rewrites a decryption record on a validator's disk. The edit is detected within ~5 s, quarantined and restored. |
| `npm run verify-evidence -- bundle.json [--genesis data/genesis.json]` | Offline verification of an evidence bundle with no network access. |

`npm run e2e` targets `http://localhost:3000` and reads `data/` by default. To test the Docker stack, point it at the container's port and data folder:

```bash
SAKSHI_URL=http://localhost:3100 SAKSHI_DATA=docker-data npm run e2e
```

On 2026-10-05 the Docker stack passed all 32 checks this way, on Windows 11 with Docker Desktop.

## Threat model

| Attacker | Attack | Outcome |
|---|---|---|
| Recipient | Leaks their copy (forward, screenshot, photo, recompress) | Traced to the exact session, with a signature only they could have produced. |
| Recipient | Tries to get an unmarked copy | Impossible without `K_G`, which validators release only to the gateway for a committed record. |
| Recipient | Denies opening the document | The `DECRYPT` record carries their ML-DSA-65 signature; the `ACK` binds the exact bytes received. |
| Administrator | Edits or deletes ledger records | Block hash and QC break; validators detect, quarantine and restore. Other nodes are unaffected. |
| Administrator | Reads documents from storage | Only indistinguishable encrypted blobs; no key material at rest on the gateway. |
| Single validator (Byzantine) | Releases its share or forges blocks | One share is useless (threshold 3). It cannot form a QC alone, and votes once per height. |
| Compromised account | Decrypts as someone else | Needs that person's private key file **and** passphrase. Revocation is immediate on the ledger. |
| Quantum adversary (harvest-now) | Records traffic or storage for later | All asymmetric crypto is ML-KEM / ML-DSA. Symmetric layer is AES-256 / SHA-256. |
| Investigator | Abuses forensic queries | Every query is itself a signed, committed `FORENSIC_QUERY` record. |

## Honest limits

- **Traceable, not leak-proof.** Retyping text by hand, heavy rotation or perspective distortion, redrawing, and printing at very low quality can defeat the watermark. Sakshi then reports no attribution and never guesses.
- **Collusion.** Several recipients who average or diff their copies can weaken or locate the mark. In *preserve* mode the overlay object can be found and removed by someone who knows to look for it; use *flatten* for high-risk documents.
- **The gateway sees plaintext** for the moment it takes to watermark. In production it belongs on a hardened host or inside a TEE. It cannot decrypt on its own or without leaving a committed record.
- **Consensus.** The protocol is safe against one Byzantine validator out of four, and live with one crashed validator. An adversarial network partition at the exact moment of a vote can stall a height until it heals; it never forks.
- **Clock.** Validators accept proposals within ±30 s of their own clock, so LAN NTP (or a local time source) is required.
- **Storage failures degrade, never corrupt.** If a validator's data folder becomes unreadable (for example, a Docker Desktop bind mount dropping), the node keeps serving from its verified in-memory chain, reports `STORAGE_UNAVAILABLE` and red integrity on `/audit`, and rewrites its chain file once storage returns. While the share-release log can't be written, it refuses to release key shares, so opening a document needs the other three validators. State files are written atomically. If the node is killed mid-write anyway, the torn file is set aside as `*.corrupt-<time>`, and a torn chain line is quarantined and re-synced from peers. If the release log was lost, the node refuses to release shares for sessions committed before its restart, so a share can never be released twice.

## Demo kit

`demo/` holds a fictional storyline (a restricted procurement brief, five committee members, one chat-group leak) and everything needed to present it:

```bash
npm run demo:reset                         # fresh demo network in demo/data
SAKSHI_DATA=demo/data npm run stack        # terminal 1
npm run demo:seed                          # personas, distribution, decryptions, the leak, the trace
npm run demo:visuals                       # forensic visuals + PNG sequences  -> demo/assets/visuals, sequences
npm run demo:capture                       # 1920x1080 stills + MP4 recordings -> demo/assets/screens, recordings
```

`demo/kit/index.html` is the presenter's binder: test evidence, the live runbook and a 12-shot After Effects storyboard. `npm run test:wm-stress` reproduces the robustness benchmark.

## Layout

```
src/lib/core/     isomorphic protocol: pq.ts, vault.ts, ledger.ts, state.ts, evidence.ts, keyfile.ts, shamir.ts, merkle.ts
src/lib/client/   browser flows (shared with the e2e test) and key storage
src/lib/server/   gateway: ledger client, fail-closed pipeline, vault store, sessions, watermark client
src/app/          UI (inbox, send, sent, forensics, ledger, admin, enrol, login) + API routes
ledger/node.ts    validator node
wm-engine/        watermark engine (engine.py, pdfmark.py, server.py, tests)
scripts/          setup ceremony, stack launcher, e2e, tamper demo, offline evidence verifier
deploy/           Dockerfile (web / validator / wm targets), Caddyfile, offline packaging
docker-compose.yml        single-host stack (setup, v1..v4, wm, web); docker-compose.https.yml adds Caddy
README.md · DEPLOY.md     overview · step-by-step Docker / cloud / air-gap guide
```

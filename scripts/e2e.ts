/**
 * Full end-to-end run against a live stack (validators + watermark engine + web gateway).
 *
 *   npm run stack        # in another terminal
 *   npm run e2e          # SAKSHI_URL defaults to http://localhost:3000
 *
 * Enrols users through the registrar, distributes a PDF and an image to a group,
 * decrypts as several recipients, simulates leaks (screenshots, recompression, exact
 * copies) and checks that forensics names the right recipient with verifiable evidence.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomHex } from "../src/lib/core/bytes";
import { generateIdentity, type Identity } from "../src/lib/core/pq";
import { unlockIdentity, type KeyFile } from "../src/lib/core/keyfile";
import type { Role } from "../src/lib/core/ledger";
import {
  Api,
  ApiError,
  approveEnrolment,
  decryptDocument,
  enrolmentRequest,
  investigate,
  login,
  revokeCertificate,
  sendDocument,
  type Enrolment,
  type Person,
} from "../src/lib/client/flows";

const BASE = process.env.SAKSHI_URL ?? "http://localhost:3000";
const DATA = path.resolve(process.env.SAKSHI_DATA ?? "data");
const PY = process.env.SAKSHI_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sakshi-e2e-"));

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "  \x1b[32m✔\x1b[0m" : "  \x1b[31m✘\x1b[0m"} ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
}
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** fetch with a per-actor cookie jar */
function client(): Api {
  let cookie = "";
  return new Api(BASE, async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    let r: Response;
    try {
      r = await fetch(input, { ...init, headers });
    } catch {
      // A pooled keep-alive socket closed by a proxy fails before any response; retry once.
      r = await fetch(input, { ...init, headers });
    }
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  });
}

type Actor = { id: string; ident: Identity; api: Api; roles: Role[] };

async function main() {
  const suffix = randomHex(2);
  const anon = client();
  const cfg = await anon.config();
  console.log(`Sakshi e2e against ${BASE} · chain ${cfg.chainId.slice(0, 12)} · quorum ${cfg.quorum}/${cfg.validators.length}`);

  section("1. Identity: registrar certifies post-quantum identities");
  const regKf = JSON.parse(fs.readFileSync(path.join(DATA, "bootstrap", "registrar.sakshikey"), "utf8")) as KeyFile;
  const regPass = fs.readFileSync(path.join(DATA, "bootstrap", "registrar.pass"), "utf8").trim();
  const registrar = await unlockIdentity(regKf, regPass);
  const regApi = client();
  const rs = await login(regApi, "registrar", registrar);
  ok("registrar signs in by ML-DSA challenge", rs.kind === "registrar");

  const mk = (name: string, roles: Role[]): Actor => ({ id: `${name}-${suffix}`, ident: generateIdentity(), api: client(), roles });
  const alice = mk("alice", ["sender"]);
  const bob = mk("bob", ["recipient"]);
  const carol = mk("carol", ["recipient"]);
  const dave = mk("dave", ["recipient"]);
  const ivan = mk("ivan", ["investigator"]);
  for (const a of [alice, bob, carol, dave, ivan]) {
    const req = enrolmentRequest(a.ident, a.id, a.id.split("-")[0].replace(/^./, (c) => c.toUpperCase()) + " Example", "Ministry of Testing", a.roles);
    await anon.post("/api/enrol", req);
    const r = await approveEnrolment(regApi, registrar, "registrar", { ...req, submittedAt: Date.now() } as Enrolment, a.roles);
    ok(`certificate issued to ${a.id}`, r.height > 0, `block #${r.height}`);
    const s = await login(a.api, a.id, a.ident);
    ok(`${a.id} signs in`, s.principal === a.id);
  }
  try {
    await login(client(), "mallory-" + suffix, generateIdentity());
    ok("uncertified identity is refused", false);
  } catch (e) {
    ok("uncertified identity is refused", e instanceof ApiError && e.status === 403);
  }

  section("2. Broadcast encryption to a group");
  execFileSync(PY, ["tests/fixtures.py", "samples", TMP]);
  const { people } = await alice.api.get<{ people: (Person & { status: string })[] }>("/api/directory");
  const group = people.filter((p) => [bob.id, carol.id, dave.id].includes(p.userId));
  ok("directory lists the recipients' ML-KEM keys", group.length === 3);
  const pdf = fs.readFileSync(path.join(TMP, "sample.pdf"));
  const sentPdf = await sendDocument(alice.api, cfg, alice.ident, alice.id, { bytes: new Uint8Array(pdf), name: "briefing.pdf", mime: "application/pdf" }, "Coastal radar briefing", group, "preserve");
  ok("PDF encrypted once, stored as jumbled chunks + decoys, committed", sentPdf.height > 0, `${sentPdf.chunks} chunk(s), ${sentPdf.decoys} decoys, block #${sentPdf.height}`);
  const png = fs.readFileSync(path.join(TMP, "sample.png"));
  const sentPng = await sendDocument(alice.api, cfg, alice.ident, alice.id, { bytes: new Uint8Array(png), name: "site-photo.png", mime: "image/png" }, "Site photograph", group.filter((p) => p.userId !== dave.id), "preserve");
  ok("image distributed", sentPng.height > 0, `block #${sentPng.height}`);

  section("3. Individual decryption → unique invisible watermark per session");
  const ua = "sakshi-e2e";
  const bobPdf = await decryptDocument(bob.api, cfg, bob.ident, bob.id, sentPdf.docId, ua);
  ok("bob decrypts: record signed, committed, shares released, watermark embedded", bobPdf.bytes.length > 0, `wm ${bobPdf.meta.wmId} · ${bobPdf.meta.validators.length} validators · ${bobPdf.meta.steps.map((s) => `${s.step} ${s.ms}ms`).join(", ")}`);
  const carolPdf = await decryptDocument(carol.api, cfg, carol.ident, carol.id, sentPdf.docId, ua);
  const carolPdf2 = await decryptDocument(carol.api, cfg, carol.ident, carol.id, sentPdf.docId, ua);
  ok("every session gets a distinct watermark", new Set([bobPdf.meta.wmId, carolPdf.meta.wmId, carolPdf2.meta.wmId]).size === 3);
  ok("copies are forensically distinct files", bobPdf.meta.sha256 !== carolPdf.meta.sha256);
  ok("delivered file starts as a valid PDF", Buffer.from(bobPdf.bytes.subarray(0, 5)).toString() === "%PDF-");
  const bobPng = await decryptDocument(bob.api, cfg, bob.ident, bob.id, sentPng.docId, ua);
  const carolPng = await decryptDocument(carol.api, cfg, carol.ident, carol.id, sentPng.docId, ua);
  ok("image decrypted by two recipients", bobPng.meta.wmId !== carolPng.meta.wmId);
  try {
    await decryptDocument(dave.api, cfg, dave.ident, dave.id, sentPng.docId, ua);
    ok("non-recipient cannot decrypt", false);
  } catch (e) {
    ok("non-recipient cannot decrypt", e instanceof ApiError && e.status === 403, (e as Error).message);
  }

  section("4. Leak forensics");
  const save = (name: string, b: Uint8Array) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, b);
    return p;
  };
  const leak = (src: string, mode: string, ext: string) => {
    const out = path.join(TMP, `leak-${mode}.${ext}`);
    execFileSync(PY, ["tests/fixtures.py", "leak", src, out, mode]);
    return { bytes: new Uint8Array(fs.readFileSync(out)), name: path.basename(out) };
  };
  const cases: { label: string; file: { bytes: Uint8Array; name: string }; expect: string; exact?: boolean }[] = [
    { label: "exact forwarded PDF (bob)", file: leak(save("bob.pdf", bobPdf.bytes), "copy", "pdf"), expect: bob.id, exact: true },
    { label: "screenshot of a PDF page, JPEG (carol)", file: leak(save("carol.pdf", carolPdf.bytes), "pdf-screenshot", "jpg"), expect: carol.id },
    { label: "cropped + zoomed page capture (carol, 2nd session)", file: leak(save("carol2.pdf", carolPdf2.bytes), "pdf-page-photo", "jpg"), expect: carol.id },
    { label: "cropped, downscaled image screenshot (bob)", file: leak(save("bob.png", bobPng.bytes), "image-screenshot", "png"), expect: bob.id },
    { label: "recompressed JPEG of the image (carol)", file: leak(save("carol.png", carolPng.bytes), "image-jpeg", "jpg"), expect: carol.id },
  ];
  for (const c of cases) {
    const r = await investigate(ivan.api, ivan.ident, ivan.id, c.file);
    const v = r.localVerdict;
    const right = r.extraction.found && v?.verdict === "ATTRIBUTED" && v.subject?.userId === c.expect;
    ok(`${c.label} → ${c.expect}`, right, r.extraction.found ? `${r.extraction.match_sigma}σ, verified locally: ${v?.verdict}` : `not found: ${r.extraction.reason ?? r.message}`);
    if (c.exact) ok("  exact copy matched to the delivery hash and signed receipt", !!v?.subject?.exactCopy && !!v?.subject?.acknowledged);
    if (right && c === cases[0]) save("evidence.json", new TextEncoder().encode(JSON.stringify(r.bundle, null, 2)));
  }
  const clean = await investigate(ivan.api, ivan.ident, ivan.id, { bytes: new Uint8Array(pdf), name: "original.pdf" });
  ok("original (never decrypted through Sakshi) has no watermark", !clean.extraction.found);

  section("5. Tamper-evidence of the evidence bundle");
  const bundle = JSON.parse(fs.readFileSync(path.join(TMP, "evidence.json"), "utf8"));
  bundle.recipientCert.tx.body.name = "Someone Else";
  const { verifyEvidence } = await import("../src/lib/core/evidence");
  ok("editing the bundle breaks verification", verifyEvidence(bundle).verdict === "NOT_VERIFIED");
  ok("offline CLI verifier accepts the genuine bundle", execFileSync("npx", ["tsx", "scripts/verify-evidence.ts", path.join(TMP, "evidence.json")], { shell: process.platform === "win32" }).toString().includes("ATTRIBUTED"));

  section("6. Revocation");
  const dir = await regApi.get<{ people: { userId: string; certTxId: string }[] }>("/api/directory");
  const carolCert = dir.people.find((p) => p.userId === carol.id)!;
  await revokeCertificate(regApi, registrar, "registrar", carol.id, carolCert.certTxId, "e2e: device lost");
  try {
    await decryptDocument(carol.api, cfg, carol.ident, carol.id, sentPdf.docId, ua);
    ok("revoked recipient can no longer decrypt", false);
  } catch (e) {
    ok("revoked recipient can no longer decrypt", e instanceof ApiError, (e as Error).message);
  }
  const again = await investigate(ivan.api, ivan.ident, ivan.id, cases[1].file);
  ok("earlier leak is still attributable after revocation", again.localVerdict?.subject?.userId === carol.id);

  console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} passed, ${failed} failed\x1b[0m   artifacts: ${TMP}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("\n\x1b[31mE2E aborted:\x1b[0m", e);
  process.exit(1);
});

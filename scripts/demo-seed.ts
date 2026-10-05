/**
 * Seeds the demo network with a fictional storyline and records every id for the
 * presentation and the video assets.
 *
 *   SAKSHI_DATA=demo/data npm run stack     # separate terminal
 *   npm run demo:seed
 *
 * Story: the Directorate of Coastal Security circulates a restricted procurement brief to
 * a five-member evaluation committee. Four members open it. One of them, Rahul Verma, posts
 * a phone screenshot of page 2 in a chat group. The investigator traces it.
 * All people and organisations are fictional.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lockIdentity, unlockIdentity, type KeyFile } from "../src/lib/core/keyfile";
import { generateIdentity, type Identity } from "../src/lib/core/pq";
import type { Role } from "../src/lib/core/ledger";
import { Api, approveEnrolment, decryptDocument, enrolmentRequest, investigate, login, sendDocument, type Enrolment, type Person } from "../src/lib/client/flows";

const BASE = process.env.SAKSHI_URL ?? "http://localhost:3000";
const DEMO = path.resolve("demo");
const DATA = path.join(DEMO, "data");
const PASS = process.env.SAKSHI_DEMO_PASSPHRASE ?? "Sakshi-Demo-2026";
const PY = process.env.SAKSHI_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const PEOPLE: { id: string; name: string; org: string; roles: Role[]; title: string }[] = [
  { id: "anita.desai", name: "Anita Desai", org: "Directorate of Coastal Security", roles: ["sender", "recipient"], title: "Joint Secretary, sender" },
  { id: "arjun.mehta", name: "Cdr. Arjun Mehta", org: "Naval Operations", roles: ["recipient"], title: "Committee member" },
  { id: "kavya.rao", name: "Dr. Kavya Rao", org: "Defence Electronics Lab", roles: ["recipient"], title: "Committee member" },
  { id: "rahul.verma", name: "Rahul Verma", org: "Finance Division", roles: ["recipient"], title: "Committee member (the leaker)" },
  { id: "priya.nair", name: "Priya Nair", org: "Legal Cell", roles: ["recipient"], title: "Committee member" },
  { id: "sanjay.kulkarni", name: "Sanjay Kulkarni", org: "Procurement Wing", roles: ["recipient"], title: "Committee member (never opens it)" },
  { id: "vikram.singh", name: "Vikram Singh", org: "Cyber Forensics Unit", roles: ["investigator"], title: "Investigator" },
];

function client(): Api {
  let cookie = "";
  return new Api(BASE, async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const r = await fetch(input, { ...init, headers });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  });
}

async function main() {
  for (const d of ["keys", "delivered", "leak", "evidence"]) fs.mkdirSync(path.join(DEMO, d), { recursive: true });
  const anon = client();
  const cfg = await anon.config();
  console.log(`demo network ${cfg.network} · chain ${cfg.chainId.slice(0, 12)}`);

  const regKf = JSON.parse(fs.readFileSync(path.join(DATA, "bootstrap", "registrar.sakshikey"), "utf8")) as KeyFile;
  const regPass = fs.readFileSync(path.join(DATA, "bootstrap", "registrar.pass"), "utf8").trim();
  const registrar = await unlockIdentity(regKf, regPass);
  const regApi = client();
  await login(regApi, "registrar", registrar);
  fs.copyFileSync(path.join(DATA, "bootstrap", "registrar.sakshikey"), path.join(DEMO, "keys", "registrar.sakshikey"));

  const actors = new Map<string, { ident: Identity; api: Api }>();
  for (const p of PEOPLE) {
    const ident = generateIdentity();
    const kf = await lockIdentity(ident, p.id, "user", PASS);
    fs.writeFileSync(path.join(DEMO, "keys", `${p.id}.sakshikey`), JSON.stringify(kf, null, 2));
    const req = enrolmentRequest(ident, p.id, p.name, p.org, p.roles, p.title);
    await anon.post("/api/enrol", req);
    const r = await approveEnrolment(regApi, registrar, "registrar", { ...req, submittedAt: Date.now() } as Enrolment, p.roles);
    const api = client();
    await login(api, p.id, ident);
    actors.set(p.id, { ident, api });
    console.log(`  certified ${p.id.padEnd(16)} block #${r.height}`);
  }
  // One pending enrolment so the registry screen has something to approve live.
  const pending = generateIdentity();
  const pkf = await lockIdentity(pending, "meera.iyer", "user", PASS);
  fs.writeFileSync(path.join(DEMO, "keys", "meera.iyer.sakshikey"), JSON.stringify(pkf, null, 2));
  await anon.post("/api/enrol", enrolmentRequest(pending, "meera.iyer", "Meera Iyer", "Audit & Accounts", ["recipient"], "Joining the committee as auditor"));

  const anita = actors.get("anita.desai")!;
  const { people } = await anita.api.get<{ people: Person[] }>("/api/directory");
  const committee = people.filter((p) => ["arjun.mehta", "kavya.rao", "rahul.verma", "priya.nair", "sanjay.kulkarni"].includes(p.userId));
  const pdf = new Uint8Array(fs.readFileSync(path.join(DEMO, "source", "Coastal-Radar-Phase-II-Brief.pdf")));
  const brief = await sendDocument(anita.api, cfg, anita.ident, "anita.desai", { bytes: pdf, name: "Coastal-Radar-Phase-II-Brief.pdf", mime: "application/pdf" }, "Coastal Radar Network – Phase II Procurement Brief", committee, "preserve");
  console.log(`  brief distributed: doc ${brief.docId} · block #${brief.height} · ${brief.chunks} chunk(s) + ${brief.decoys} decoys`);
  const png = new Uint8Array(fs.readFileSync(path.join(DEMO, "source", "Site-Survey-Sector-7.png")));
  const site = await sendDocument(anita.api, cfg, anita.ident, "anita.desai", { bytes: png, name: "Site-Survey-Sector-7.png", mime: "image/png" }, "Site survey – Sector 7", committee.filter((p) => p.userId !== "sanjay.kulkarni"), "preserve");
  console.log(`  site image distributed: doc ${site.docId} · block #${site.height}`);

  const sessions: Record<string, unknown> = {};
  for (const id of ["arjun.mehta", "kavya.rao", "priya.nair", "rahul.verma"]) {
    const a = actors.get(id)!;
    const r = await decryptDocument(a.api, cfg, a.ident, id, brief.docId, "Sakshi demo seed");
    fs.writeFileSync(path.join(DEMO, "delivered", `brief.${id}.pdf`), r.bytes);
    sessions[id] = { wmId: r.meta.wmId, decryptTxId: r.meta.decryptTxId, deliveryTxId: r.meta.deliveryTxId, ackTxId: r.ackTxId, block: r.meta.blockHeight, sha256: r.meta.sha256, steps: r.meta.steps };
    console.log(`  ${id.padEnd(14)} opened the brief · watermark ${r.meta.wmId} · block #${r.meta.blockHeight}`);
  }
  for (const id of ["arjun.mehta", "rahul.verma"]) {
    const a = actors.get(id)!;
    const r = await decryptDocument(a.api, cfg, a.ident, id, site.docId, "Sakshi demo seed");
    fs.writeFileSync(path.join(DEMO, "delivered", `site.${id}.png`), r.bytes);
  }

  const leakPath = path.join(DEMO, "leak", "chat-screenshot.jpg");
  execFileSync(PY, ["demo/tools/make_docs.py", "leak", path.join(DEMO, "delivered", "brief.rahul.verma.pdf"), leakPath], { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  console.log(`  leak created: ${path.relative(process.cwd(), leakPath)}`);

  const vikram = actors.get("vikram.singh")!;
  const inv = await investigate(vikram.api, vikram.ident, "vikram.singh", { bytes: new Uint8Array(fs.readFileSync(leakPath)), name: "chat-screenshot.jpg" });
  const who = inv.localVerdict?.subject;
  console.log(`  forensics: ${inv.extraction.found ? `${inv.extraction.match_sigma}σ → ${who?.name} (${inv.localVerdict?.verdict})` : `NOT FOUND (${inv.extraction.reason})`}`);
  if (inv.bundle) fs.writeFileSync(path.join(DEMO, "evidence", "evidence-rahul.verma.json"), JSON.stringify(inv.bundle, null, 2));

  fs.writeFileSync(
    path.join(DEMO, "demo-state.json"),
    JSON.stringify({ base: BASE, chainId: cfg.chainId, passphrase: PASS, people: PEOPLE, brief, site, sessions, investigation: { extraction: inv.extraction, verdict: inv.localVerdict, queryTxId: inv.queryTxId } }, null, 2),
  );
  console.log(`\nDemo ready. Every demo identity uses the passphrase "${PASS}". Key files: demo/keys/`);
  if (!inv.extraction.found || who?.userId !== "rahul.verma") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * One-time ceremony: creates the permissioned network.
 *
 *   npm run setup                       # 4 validators on 127.0.0.1
 *   npm run setup -- --hosts 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.14 --force
 *
 * Writes (all under ./data, never committed):
 *   genesis.json                 public network definition signed by every validator
 *   nodes/<id>/key.json          each validator's passphrase-locked ML-DSA + ML-KEM keys
 *   gateway/key.json             gateway keys (signs deliveries, receives K_G shares)
 *   secrets/*                    passphrases, watermark key, internal token, session key
 *   bootstrap/registrar.sakshikey + registrar.pass  — import into the browser, then delete
 *
 * In a real deployment run this ceremony on an offline machine and hand each validator
 * operator only their own key file and passphrase.
 */
import fs from "node:fs";
import path from "node:path";
import { randomHex, toB64 } from "../src/lib/core/bytes";
import { chainIdOf, GENESIS_DOMAIN, type Genesis, type GenesisBody } from "../src/lib/core/ledger";
import { lockIdentity } from "../src/lib/core/keyfile";
import { generateIdentity, sign } from "../src/lib/core/pq";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DATA = path.resolve(process.env.SAKSHI_DATA ?? path.join(process.cwd(), "data"));
const hosts = (opt("hosts") ?? "127.0.0.1,127.0.0.1,127.0.0.1,127.0.0.1").split(",");
const basePort = Number(opt("base-port") ?? 7101);
const VALIDATOR_NAMES = [
  "Validator 1 · Issuing Authority",
  "Validator 2 · Security Operations",
  "Validator 3 · Independent Auditor",
  "Validator 4 · Legal & Compliance",
  "Validator 5",
  "Validator 6",
  "Validator 7",
];

async function main() {
  if (fs.existsSync(path.join(DATA, "genesis.json")) && !flag("force")) {
    console.error(`A network already exists in ${DATA}. Use --force to wipe it and start a new chain.`);
    process.exit(1);
  }
  if (flag("force")) fs.rmSync(DATA, { recursive: true, force: true });
  const n = hosts.length;
  if (n < 4) throw new Error("at least 4 validators are required to tolerate one Byzantine node");
  const f = Math.floor((n - 1) / 3);
  const quorum = n - f; // ≥ 2f+1: any two quorums share an honest validator
  for (const d of ["nodes", "gateway", "secrets", "bootstrap", "vault"]) fs.mkdirSync(path.join(DATA, d), { recursive: true });

  console.log(`Creating ${n} validators (tolerates f=${f}, quorum ${quorum}, key-share threshold ${quorum})…`);
  const validators = [];
  for (let i = 0; i < n; i++) {
    const id = `v${i + 1}`;
    const ident = generateIdentity();
    const pass = randomHex(24);
    const kf = await lockIdentity(ident, id, "validator", pass);
    fs.mkdirSync(path.join(DATA, "nodes", id), { recursive: true });
    fs.writeFileSync(path.join(DATA, "nodes", id, "key.json"), JSON.stringify(kf, null, 2));
    fs.writeFileSync(path.join(DATA, "secrets", `${id}.pass`), pass, { mode: 0o600 });
    validators.push({ id, ident, info: { id, name: VALIDATOR_NAMES[i] ?? `Validator ${i + 1}`, url: `http://${hosts[i]}:${basePort + i}`, dsaPk: kf.dsaPk, kemPk: kf.kemPk } });
  }

  const gw = generateIdentity();
  const gwPass = randomHex(24);
  const gwKf = await lockIdentity(gw, "gateway", "gateway", gwPass);
  fs.writeFileSync(path.join(DATA, "gateway", "key.json"), JSON.stringify(gwKf, null, 2));
  fs.writeFileSync(path.join(DATA, "secrets", "gateway.pass"), gwPass, { mode: 0o600 });

  const reg = generateIdentity();
  const regPass = randomHex(8).match(/.{4}/g)!.join("-") + "-" + randomHex(4);
  const regKf = await lockIdentity(reg, "registrar", "registrar", regPass);
  fs.writeFileSync(path.join(DATA, "bootstrap", "registrar.sakshikey"), JSON.stringify(regKf, null, 2));
  fs.writeFileSync(path.join(DATA, "bootstrap", "registrar.pass"), regPass, { mode: 0o600 });

  const body: GenesisBody = {
    network: opt("network") ?? "sakshi-airgap",
    createdAt: Date.now(),
    quorum,
    shareThreshold: quorum,
    validators: validators.map((v) => v.info),
    registrars: [{ id: "registrar", name: "Registration Authority", dsaPk: regKf.dsaPk }],
    gateway: { id: "gateway", dsaPk: gwKf.dsaPk, kemPk: gwKf.kemPk },
  };
  const chainId = chainIdOf(body);
  const genesis: Genesis = {
    body,
    chainId,
    signatures: validators.map((v) => ({ validatorId: v.id, sig: toB64(sign(v.ident.dsa.secretKey, GENESIS_DOMAIN, chainId)) })),
  };
  fs.writeFileSync(path.join(DATA, "genesis.json"), JSON.stringify(genesis, null, 2));

  fs.writeFileSync(path.join(DATA, "secrets", "wm.key"), randomHex(32), { mode: 0o600 });
  fs.writeFileSync(path.join(DATA, "secrets", "internal.token"), randomHex(32), { mode: 0o600 });
  fs.writeFileSync(path.join(DATA, "secrets", "session.key"), randomHex(32), { mode: 0o600 });

  console.log(`\nChain id   ${chainId}`);
  console.log(`Validators ${validators.map((v) => `${v.id}@${v.info.url}`).join("  ")}`);
  console.log(`\nRegistrar key file : ${path.join(DATA, "bootstrap", "registrar.sakshikey")}`);
  console.log(`Registrar passphrase: ${regPass}`);
  console.log("Import the registrar key on the Sign-in page, then delete data/bootstrap.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

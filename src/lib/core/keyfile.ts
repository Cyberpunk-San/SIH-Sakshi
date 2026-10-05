// Passphrase-protected identity file (".sakshikey"). Private keys never leave the
// holder's device unencrypted; the server only ever sees public keys.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { canonical, fromB64, fromUtf8, randomBytes, toB64, utf8 } from "./bytes";
import { aeadDecrypt, aeadEncrypt, type Identity } from "./pq";

export type KeyFile = {
  format: "sakshi-key/v1";
  principal: string; // user id, registrar id, validator id or "gateway"
  kind: "user" | "registrar" | "validator" | "gateway";
  dsaPk: string;
  kemPk: string;
  kdf: { alg: "argon2id"; m: number; t: number; p: number; salt: string };
  box: string;
  createdAt: number;
};

const KDF_PARAMS = { m: 19456, t: 2, p: 1 }; // OWASP 2024 minimum for argon2id

async function deriveKey(passphrase: string, salt: Uint8Array, p = KDF_PARAMS): Promise<Uint8Array> {
  return argon2idAsync(utf8(passphrase.normalize("NFKC")), salt, { m: p.m, t: p.t, p: p.p, dkLen: 32, asyncTick: 25 });
}

export async function lockIdentity(
  identity: Identity,
  principal: string,
  kind: KeyFile["kind"],
  passphrase: string,
): Promise<KeyFile> {
  if (passphrase.length < 10) throw new Error("passphrase must be at least 10 characters");
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const secret = canonical({ dsaSk: toB64(identity.dsa.secretKey), kemSk: toB64(identity.kem.secretKey) });
  const box = aeadEncrypt(key, utf8(secret), utf8(`sakshi/keyfile/v1/${principal}`));
  key.fill(0);
  return {
    format: "sakshi-key/v1",
    principal,
    kind,
    dsaPk: toB64(identity.dsa.publicKey),
    kemPk: toB64(identity.kem.publicKey),
    kdf: { alg: "argon2id", ...KDF_PARAMS, salt: toB64(salt) },
    box: toB64(box),
    createdAt: Date.now(),
  };
}

export async function unlockIdentity(file: KeyFile, passphrase: string): Promise<Identity> {
  if (file.format !== "sakshi-key/v1") throw new Error("not a Sakshi key file");
  const key = await deriveKey(passphrase, fromB64(file.kdf.salt), file.kdf);
  let plain: Uint8Array;
  try {
    plain = aeadDecrypt(key, fromB64(file.box), utf8(`sakshi/keyfile/v1/${file.principal}`));
  } catch {
    throw new Error("wrong passphrase or corrupted key file");
  } finally {
    key.fill(0);
  }
  const s = JSON.parse(fromUtf8(plain)) as { dsaSk: string; kemSk: string };
  plain.fill(0);
  return {
    dsa: { publicKey: fromB64(file.dsaPk), secretKey: fromB64(s.dsaSk) },
    kem: { publicKey: fromB64(file.kemPk), secretKey: fromB64(s.kemSk) },
  };
}

// Post-quantum primitives: ML-KEM-768 (FIPS 203) for key establishment and
// ML-DSA-65 (FIPS 204) for signatures. Symmetric layer: AES-256-GCM + HKDF-SHA256.
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromB64, randomBytes, toB64, utf8 } from "./bytes";

export const ALG = {
  kem: "ML-KEM-768",
  sig: "ML-DSA-65",
  aead: "AES-256-GCM",
  kdf: "HKDF-SHA256",
} as const;

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type Identity = { dsa: KeyPair; kem: KeyPair };

export function generateIdentity(): Identity {
  return { dsa: ml_dsa65.keygen(), kem: ml_kem768.keygen() };
}

export function generateSigningKey(): KeyPair {
  return ml_dsa65.keygen();
}

export function generateKemKey(): KeyPair {
  return ml_kem768.keygen();
}

/** ML-DSA signature with a FIPS 204 context string for domain separation. */
export function sign(secretKey: Uint8Array, domain: string, message: Uint8Array | string): Uint8Array {
  const msg = typeof message === "string" ? utf8(message) : message;
  return ml_dsa65.sign(msg, secretKey, { context: utf8(domain) });
}

export function verify(publicKey: Uint8Array, domain: string, message: Uint8Array | string, signature: Uint8Array): boolean {
  try {
    const msg = typeof message === "string" ? utf8(message) : message;
    return ml_dsa65.verify(signature, msg, publicKey, { context: utf8(domain) });
  } catch {
    return false;
  }
}

export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  return concat(nonce, gcm(key, nonce, aad).encrypt(plaintext));
}

export function aeadDecrypt(key: Uint8Array, box: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (box.length < 28) throw new Error("ciphertext too short");
  return gcm(key, box.subarray(0, 12), aad).decrypt(box.subarray(12));
}

export function kdf(ikm: Uint8Array, info: string, salt?: Uint8Array, length = 32): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8("SAKSHI/v1/" + info), length);
}

/** A value sealed to an ML-KEM public key (KEM-DEM, HPKE-style). */
export type Sealed = { kem: string; box: string };

/**
 * Seal `plaintext` to the holder of `recipientKemPk`. `label` binds the purpose and
 * `aad` binds context (doc id, tx id...), so a sealed value cannot be replayed elsewhere.
 */
export function seal(recipientKemPk: Uint8Array, plaintext: Uint8Array, label: string, aad: Uint8Array): Sealed {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientKemPk);
  const key = kdf(sharedSecret, "seal/" + label, cipherText);
  sharedSecret.fill(0);
  return { kem: toB64(cipherText), box: toB64(aeadEncrypt(key, plaintext, aad)) };
}

export function open(recipientKemSk: Uint8Array, sealed: Sealed, label: string, aad: Uint8Array): Uint8Array {
  const cipherText = fromB64(sealed.kem);
  const sharedSecret = ml_kem768.decapsulate(cipherText, recipientKemSk);
  const key = kdf(sharedSecret, "seal/" + label, cipherText);
  sharedSecret.fill(0);
  return aeadDecrypt(key, fromB64(sealed.box), aad);
}

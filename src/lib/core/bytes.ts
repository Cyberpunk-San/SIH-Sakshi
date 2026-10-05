// Byte, encoding and canonical-JSON helpers. Isomorphic (browser + Node), no WebCrypto
// dependency, so it also works on plain-HTTP LAN deployments where crypto.subtle is absent.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes as rb } from "@noble/hashes/utils.js";

export { bytesToHex as toHex, hexToBytes as fromHex, utf8ToBytes as utf8, concatBytes as concat };

/** CSPRNG bytes of any length (getRandomValues is capped at 64 KiB per call). */
export function randomBytes(n = 32): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) out.set(rb(Math.min(65536, n - off)), off);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toB64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/[=\s]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new Error("invalid base64");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8ToBytes(data) : data);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function randomHex(n: number): string {
  return bytesToHex(randomBytes(n));
}

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` fields dropped.
 * Only integers, strings, booleans, null, arrays and plain objects are allowed, so the
 * encoding is identical across runtimes. Everything that is hashed or signed goes
 * through this function.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error(`canonical: non-integer number ${value}`);
      return String(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonical(v)).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonical: unsupported type ${typeof value}`);
  }
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonical(value));
}

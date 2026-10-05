// Shamir secret sharing over GF(2^8) (AES polynomial), byte-wise.
import { randomBytes } from "./bytes";

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by generator 3
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

export type Share = { x: number; y: Uint8Array };

export function split(secret: Uint8Array, threshold: number, count: number): Share[] {
  if (threshold < 2 || threshold > count || count > 255) throw new Error("invalid threshold parameters");
  const shares: Share[] = Array.from({ length: count }, (_, i) => ({ x: i + 1, y: new Uint8Array(secret.length) }));
  for (let b = 0; b < secret.length; b++) {
    const coeffs = randomBytes(threshold - 1);
    for (const share of shares) {
      // Horner: secret + c1 x + c2 x^2 + ...
      let acc = 0;
      for (let c = coeffs.length - 1; c >= 0; c--) acc = mul(acc, share.x) ^ coeffs[c];
      share.y[b] = mul(acc, share.x) ^ secret[b];
    }
    coeffs.fill(0);
  }
  return shares;
}

export function combine(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least two shares");
  const xs = new Set(shares.map((s) => s.x));
  if (xs.size !== shares.length) throw new Error("duplicate share index");
  const len = shares[0].y.length;
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis at x = 0
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = mul(num, shares[j].x);
        den = mul(den, shares[i].x ^ shares[j].x);
      }
      acc ^= mul(shares[i].y[b], div(num, den));
    }
    out[b] = acc;
  }
  return out;
}

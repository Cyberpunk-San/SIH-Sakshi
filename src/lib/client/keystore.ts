// Browser key storage: only passphrase-encrypted key files are persisted.
import type { KeyFile } from "@/lib/core/keyfile";

const KEY = "sakshi.keys.v1";

function read(): Record<string, KeyFile> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function listKeys(): KeyFile[] {
  return Object.values(read()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getKey(principal: string): KeyFile | null {
  return read()[principal] ?? null;
}

export function saveKey(kf: KeyFile) {
  const all = read();
  all[kf.principal] = kf;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private mode): the user still has the downloaded file
  }
}

export function removeKey(principal: string) {
  const all = read();
  delete all[principal];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

export function parseKeyFile(text: string): KeyFile {
  const kf = JSON.parse(text) as KeyFile;
  if (kf.format !== "sakshi-key/v1" || !kf.principal || !kf.box) throw new Error("This is not a Sakshi key file.");
  return kf;
}

export function downloadBytes(bytes: Uint8Array | string, name: string, mime = "application/octet-stream") {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

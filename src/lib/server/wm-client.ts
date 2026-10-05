import "server-only";
import { secrets, WM_URL } from "./config";
import { HttpError } from "./http";

export type ExtractResult = {
  found: boolean;
  wm_id?: string | null;
  reason?: string;
  pilot_z?: number;
  match_sigma?: number;
  false_match_probability?: number;
  bit_agreement?: number;
  rs_corrected_bytes?: number;
  scale?: number;
  kind?: string;
  pages_scanned?: number;
  elapsed_ms?: number;
};

/** POST to the engine; one retry if a pooled keep-alive socket was closed under us. */
async function post(path: string, body: () => FormData): Promise<Response> {
  const init = () => ({ method: "POST", headers: { "x-sakshi-internal": secrets().internal }, body: body(), signal: AbortSignal.timeout(180_000) });
  try {
    return await fetch(`${WM_URL}${path}`, init());
  } catch {
    return await fetch(`${WM_URL}${path}`, init());
  }
}

function form(file: Uint8Array, name: string, extra: Record<string, string> = {}) {
  const f = new FormData();
  f.append("file", new Blob([file as BlobPart]), name);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}

export async function embedWatermark(file: Uint8Array, wmId: string, pdfMode: string) {
  let r: Response;
  try {
    r = await post("/embed", () => form(file, "document", { wm_id: wmId, pdf_mode: pdfMode }));
  } catch {
    throw new HttpError(503, "watermark engine is offline");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new HttpError(502, `watermark engine: ${j.detail ?? r.statusText}`);
  }
  return {
    bytes: new Uint8Array(await r.arrayBuffer()),
    mime: r.headers.get("content-type") ?? "application/octet-stream",
    selfCheckSigma: Number(r.headers.get("x-sakshi-selfcheck-sigma") ?? 0),
    embedMs: Number(r.headers.get("x-sakshi-embed-ms") ?? 0),
  };
}

export async function extractWatermark(file: Uint8Array, name: string): Promise<ExtractResult> {
  let r: Response;
  try {
    r = await post("/extract", () => form(file, name));
  } catch {
    throw new HttpError(503, "watermark engine is offline");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 415 ? 415 : 502, j.detail ?? "extraction failed");
  return j as ExtractResult;
}

export async function wmHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${WM_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

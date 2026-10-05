"""
Sakshi watermark service.  Loopback-only HTTP service used by the decryption gateway.

    python -m uvicorn server:app --host 127.0.0.1 --port 7200

Environment:
    SAKSHI_WM_KEY_FILE   path to a file containing the 32-byte watermark key as hex
    SAKSHI_INTERNAL_TOKEN shared secret the gateway sends in X-Sakshi-Internal
"""
from __future__ import annotations

import hmac
import os
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

import engine
import pdfmark

MAX_BYTES = 60 * 1024 * 1024


def _load_key() -> bytes:
    path = os.environ.get("SAKSHI_WM_KEY_FILE")
    if path and os.path.exists(path):
        raw = open(path, "r", encoding="utf-8").read().strip()
    else:
        raw = os.environ.get("SAKSHI_WM_KEY", "")
    key = bytes.fromhex(raw) if raw else b""
    if len(key) != 32:
        raise RuntimeError("watermark key missing: run `npm run setup` (SAKSHI_WM_KEY_FILE)")
    return key


KEY = _load_key()
TOKEN = os.environ.get("SAKSHI_INTERNAL_TOKEN", "")

app = FastAPI(title="Sakshi watermark engine", docs_url=None, redoc_url=None, openapi_url=None)


def _auth(token: str | None) -> None:
    if not TOKEN or not token or not hmac.compare_digest(token, TOKEN):
        raise HTTPException(status_code=401, detail="unauthorised")


def kind_of(data: bytes) -> str:
    if data[:5] == b"%PDF-":
        return "pdf"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:2] in (b"BM",) or data[:4] in (b"II*\x00", b"MM\x00*"):
        return "raster"
    raise HTTPException(status_code=415, detail="unsupported document type (PDF, PNG, JPEG, WEBP, BMP, TIFF)")


async def _read(file: UploadFile) -> bytes:
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large")
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    return data


@app.get("/health")
def health():
    return {"ok": True, "engine": "sakshi-wm/1", "payload_bits": engine.CODE_BITS}


@app.post("/embed")
async def embed(
    file: UploadFile = File(...),
    wm_id: str = Form(...),
    pdf_mode: str = Form("preserve"),
    x_sakshi_internal: str | None = Header(default=None),
):
    _auth(x_sakshi_internal)
    if len(wm_id) != 16 or any(c not in "0123456789abcdef" for c in wm_id):
        raise HTTPException(status_code=400, detail="wm_id must be 16 lowercase hex chars")
    data = await _read(file)
    kind = kind_of(data)
    t0 = time.time()
    if kind == "pdf":
        out = pdfmark.embed_pdf(data, KEY, wm_id, mode=pdf_mode)
        mime = "application/pdf"
        check = pdfmark.extract_pdf(out, KEY)
    else:
        out, mime = engine.embed_image(data, KEY, wm_id)
        check = engine.extract_image(out, KEY)
    # Fail closed: never release a copy whose watermark cannot be read back.
    if not check.get("found") or check.get("wm_id") != wm_id:
        raise HTTPException(status_code=500, detail=f"watermark self-check failed: {check}")
    return Response(
        content=out,
        media_type=mime,
        headers={
            "X-Sakshi-Kind": kind,
            "X-Sakshi-Selfcheck-Sigma": str(check.get("match_sigma")),
            "X-Sakshi-Embed-Ms": str(int((time.time() - t0) * 1000)),
        },
    )


@app.post("/extract")
async def extract(file: UploadFile = File(...), x_sakshi_internal: str | None = Header(default=None)):
    _auth(x_sakshi_internal)
    data = await _read(file)
    kind = kind_of(data)
    t0 = time.time()
    result = pdfmark.extract_pdf(data, KEY) if kind == "pdf" else engine.extract_image(data, KEY)
    result["kind"] = kind
    result["elapsed_ms"] = int((time.time() - t0) * 1000)
    return JSONResponse(result)

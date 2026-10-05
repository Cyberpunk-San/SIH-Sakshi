"""Statistical robustness benchmark for the watermark engine.

    python tests/stress_wm.py [trials] [out.json]

For each leak scenario, embeds `trials` random watermark ids, applies the attack and
checks the decoded id. Also measures false positives on unmarked files and wrong keys.
"""
import io
import json
import os
import secrets
import sys
import tempfile
import time

import numpy as np
from PIL import Image

sys.path[:0] = [os.path.join(os.path.dirname(__file__), "..", "wm-engine"), os.path.dirname(__file__)]
import engine  # noqa: E402
import fixtures  # noqa: E402
import pdfmark  # noqa: E402
import pymupdf  # noqa: E402

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 20
OUT = sys.argv[2] if len(sys.argv) > 2 else None
KEY = os.urandom(32)
TMP = tempfile.mkdtemp()
fixtures.samples(TMP)
PDF = open(f"{TMP}/sample.pdf", "rb").read()
PNG = open(f"{TMP}/sample.png", "rb").read()


def jpeg(im: Image.Image, q: int) -> bytes:
    b = io.BytesIO()
    im.convert("RGB").save(b, "JPEG", quality=q)
    return b.getvalue()


def page(pdf: bytes, dpi: int, n: int = 1) -> Image.Image:
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    pix = doc[n].get_pixmap(dpi=dpi)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def scenarios():
    def pdf_case(mode, attack):
        def run(wm):
            marked = pdfmark.embed_pdf(PDF, KEY, wm, mode)
            return attack(marked)
        return run

    def img_case(attack):
        def run(wm):
            data, _ = engine.embed_image(PNG, KEY, wm)
            return attack(Image.open(io.BytesIO(data)).convert("RGB"), data)
        return run

    def photo_crop(m):
        im = page(m, 96)
        w, h = im.size
        return jpeg(im.crop((40, 60, w - 30, h - 80)).resize((int(w * 1.3), int(h * 1.3)), Image.Resampling.BILINEAR), 82)

    return {
        "PDF (preserve) forwarded as-is": ("pdf", pdf_case("preserve", lambda m: m)),
        "PDF (flatten) forwarded as-is": ("pdf", pdf_case("flatten", lambda m: m)),
        "PDF page screenshot @72 dpi, JPEG 80": ("img", pdf_case("preserve", lambda m: jpeg(page(m, 72), 80))),
        "PDF page screenshot @110 dpi, JPEG 82": ("img", pdf_case("preserve", lambda m: jpeg(page(m, 110), 82))),
        "PDF page cropped + uneven zoom, JPEG 82": ("img", pdf_case("preserve", photo_crop)),
        "Flattened PDF page @144 dpi, JPEG 75": ("img", pdf_case("flatten", lambda m: jpeg(page(m, 144), 75))),
        "Image recompressed JPEG 60": ("img", img_case(lambda im, d: jpeg(im, 60))),
        "Image cropped 15% + 0.7x, PNG": ("img", img_case(lambda im, d: _png(im.crop((90, 70, im.width - 100, im.height - 75)).resize((int(im.width * 0.7), int(im.height * 0.7)), Image.Resampling.LANCZOS)))),
        "Image 1.6x upscale (zoomed screenshot), JPEG 85": ("img", img_case(lambda im, d: jpeg(im.resize((int(im.width * 1.6), int(im.height * 1.6)), Image.Resampling.BILINEAR), 85))),
        "Image stretched 1.1x by 0.9y, JPEG 80": ("img", img_case(lambda im, d: jpeg(im.resize((int(im.width * 1.1), int(im.height * 0.9)), Image.Resampling.BICUBIC), 80))),
    }


def _png(im):
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def extract(kind, data):
    if kind == "pdf":
        return pdfmark.extract_pdf(data, KEY)
    return engine.extract_image(data, KEY)


def main():
    results = []
    print(f"{TRIALS} random watermark ids per scenario\n")
    for name, (kind, run) in scenarios().items():
        ok, sig, ms = 0, [], []
        for _ in range(TRIALS):
            wm = secrets.token_hex(8)
            leaked = run(wm)
            t = time.time()
            r = extract(kind, leaked)
            ms.append((time.time() - t) * 1000)
            if r.get("found") and r.get("wm_id") == wm:
                ok += 1
                sig.append(r["match_sigma"])
        row = {"scenario": name, "attributed": ok, "trials": TRIALS, "mean_sigma": round(float(np.mean(sig)), 2) if sig else None,
               "min_sigma": round(float(np.min(sig)), 2) if sig else None, "mean_ms": int(np.mean(ms))}
        results.append(row)
        print(f"{ok:>3}/{TRIALS}  {name:<48} mean {row['mean_sigma']}σ  min {row['min_sigma']}σ  {row['mean_ms']} ms")

    fp = 0
    for _ in range(TRIALS):
        if engine.extract_image(PNG, os.urandom(32)).get("found"):
            fp += 1
        if pdfmark.extract_pdf(PDF, KEY).get("found"):
            fp += 1
    wrong_key = 0
    for _ in range(TRIALS):
        data, _ = engine.embed_image(PNG, KEY, secrets.token_hex(8))
        if engine.extract_image(data, os.urandom(32)).get("found"):
            wrong_key += 1
    print(f"\nfalse positives on unmarked files: {fp}/{2 * TRIALS}   watermark read with wrong key: {wrong_key}/{TRIALS}")
    if OUT:
        json.dump({"trials": TRIALS, "scenarios": results, "false_positives": fp, "fp_trials": 2 * TRIALS, "wrong_key_reads": wrong_key}, open(OUT, "w"), indent=2)


if __name__ == "__main__":
    main()

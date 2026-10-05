"""
Sakshi forensic watermark engine.

Blind, keyed spread-spectrum watermark for raster images and PDF pages.

Design
------
* Payload: 64-bit watermark id (wm_id) + 8 Reed-Solomon parity bytes = 128 bits.
* A 128x128-pixel tile is divided into 32x32 "chips" of 4x4 pixels. Each chip carries
  a keyed pseudo-random sign and belongs to one payload bit (keyed assignment).
  A separate keyed pilot pattern is added on top; it gives blind alignment
  (crop offset), polarity and scale recovery during extraction.
* The tile is repeated over the whole image, so every bit is spread over
  thousands of chips. Extraction folds the high-passed image onto one tile and
  correlates, which averages out document content.
* Embedding strength is perceptually masked: lower in flat regions, higher in
  textured regions, and only "darkening" on pure-white paper so pages stay white.

The pattern depends on a secret key (SAKSHI_WM_KEY). Without the key an adversary
cannot regenerate the pattern to subtract it.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps
from reedsolo import RSCodec, ReedSolomonError
from scipy import ndimage

TILE = 128
CHIP = 4
CHIPS = TILE // CHIP  # 32 chips per side
PAYLOAD_BYTES = 8
PARITY_BYTES = 8
CODE_BITS = (PAYLOAD_BYTES + PARITY_BYTES) * 8  # 128

# Embedding strengths in 8-bit luma levels.
STRENGTH_FLAT = 1.6
STRENGTH_TEXTURE = 6.0
PILOT_WEIGHT = 0.6
DATA_WEIGHT = 1.0

_rs = RSCodec(PARITY_BYTES)


@dataclass(frozen=True)
class Pattern:
    pilot: np.ndarray  # (CHIPS, CHIPS) +-1
    chip_sign: np.ndarray  # (CHIPS, CHIPS) +-1
    chip_bit: np.ndarray  # (CHIPS, CHIPS) int bit index


_pattern_cache: dict[bytes, Pattern] = {}


def _prng(key: bytes, label: str) -> np.random.Generator:
    seed = hmac.new(key, ("sakshi/wm/v1/" + label).encode(), hashlib.sha256).digest()
    return np.random.Generator(np.random.PCG64(int.from_bytes(seed, "big")))


def pattern_for(key: bytes) -> Pattern:
    if key in _pattern_cache:
        return _pattern_cache[key]
    pilot = _prng(key, "pilot").choice([-1.0, 1.0], size=(CHIPS, CHIPS))
    chip_sign = _prng(key, "sign").choice([-1.0, 1.0], size=(CHIPS, CHIPS))
    # Balanced assignment: every bit gets exactly CHIPS*CHIPS/CODE_BITS chips.
    order = _prng(key, "assign").permutation(CHIPS * CHIPS)
    chip_bit = (order % CODE_BITS).reshape(CHIPS, CHIPS)
    p = Pattern(pilot=pilot, chip_sign=chip_sign, chip_bit=chip_bit)
    _pattern_cache[key] = p
    return p


def encode_payload(wm_id: str) -> np.ndarray:
    raw = bytes.fromhex(wm_id)
    if len(raw) != PAYLOAD_BYTES:
        raise ValueError("wm_id must be 16 hex characters")
    coded = bytes(_rs.encode(raw))
    bits = np.unpackbits(np.frombuffer(coded, dtype=np.uint8)).astype(np.float64)
    return bits * 2.0 - 1.0  # {0,1} -> {-1,+1}


def decode_payload(soft: np.ndarray) -> tuple[str | None, int]:
    bits = (soft > 0).astype(np.uint8)
    coded = np.packbits(bits).tobytes()
    try:
        decoded, _, errata = _rs.decode(coded)
        return bytes(decoded).hex(), len(errata)
    except ReedSolomonError:
        return None, -1


def tile_signal(key: bytes, wm_id: str) -> np.ndarray:
    """Chip-level signal in [-1.6, 1.6] for one tile (CHIPS x CHIPS)."""
    p = pattern_for(key)
    bits = encode_payload(wm_id)
    data = p.chip_sign * bits[p.chip_bit]
    return PILOT_WEIGHT * p.pilot + DATA_WEIGHT * data


def _expand(chips: np.ndarray, h: int, w: int, scale: int = 1) -> np.ndarray:
    """Tile the chip pattern over h x w pixels; `scale` enlarges chips (for high-DPI rasters)."""
    tile = np.kron(chips, np.ones((CHIP * scale, CHIP * scale)))
    t = TILE * scale
    reps = (-(-h // t), -(-w // t))
    return np.tile(tile, reps)[:h, :w]


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _mask(luma: np.ndarray) -> np.ndarray:
    """Perceptual strength map.

    Fine texture (photos, grain) hides a stronger signal; flat paper and hard ink
    edges (text strokes, where a halo would be noticeable) get the weak setting."""
    local_mean = ndimage.uniform_filter(luma, 7)
    local_var = ndimage.uniform_filter(luma * luma, 7) - local_mean * local_mean
    texture = np.clip(np.sqrt(np.maximum(local_var, 0.0)) / 24.0, 0.0, 1.0)
    kernel = np.ones((5, 5), np.uint8)
    l32 = luma.astype(np.float32)
    hard_edge = (cv2.dilate(l32, kernel) - cv2.erode(l32, kernel)) > 90.0
    texture[hard_edge] = 0.0
    return STRENGTH_FLAT + (STRENGTH_TEXTURE - STRENGTH_FLAT) * texture


def embed_array(rgb: np.ndarray, key: bytes, wm_id: str, scale: int = 1) -> np.ndarray:
    """rgb: HxWx3 uint8 -> watermarked HxWx3 uint8 (visually identical)."""
    img = rgb.astype(np.float64)
    h, w = img.shape[:2]
    signal = _expand(tile_signal(key, wm_id), h, w, scale) / (PILOT_WEIGHT + DATA_WEIGHT)
    luma = _luma(img)
    strength = _mask(luma)
    delta = strength * signal
    # Near-white paper: shift the pattern down so it never needs to exceed 255.
    headroom = 255.0 - img.max(axis=2)
    need = np.clip(strength - headroom, 0.0, None)
    delta = delta - need
    # Near-black ink: shift up likewise.
    floor = img.min(axis=2)
    need_up = np.clip(strength - floor, 0.0, None)
    delta = delta + need_up * (floor < strength)
    out = img + delta[..., None]
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def overlay_rgba(width: int, height: int, key: bytes, wm_id: str, strength: float = 5.0) -> np.ndarray:
    """Darkening-only RGBA overlay (black + alpha) for vector PDF pages."""
    signal = _expand(tile_signal(key, wm_id), height, width) / (PILOT_WEIGHT + DATA_WEIGHT)
    darkening = strength * (signal + 1.0) / 2.0  # 0..strength levels
    alpha = np.clip(np.rint(darkening), 0, 255).astype(np.uint8)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., 3] = alpha
    return rgba


# ---------------------------------------------------------------- extraction


def _prep(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """High-pass residual plus a reliability mask.

    Text strokes and hard edges produce residuals far larger than the watermark;
    they are masked out so that only "quiet" pixels (paper, sky, skin...) vote.
    """
    g = gray.astype(np.float32)
    k = CHIP * 3 + 1
    res = g - cv2.blur(g, (k, k))
    # Local dynamic range: large near text strokes / hard edges.
    kernel = np.ones((5, 5), np.uint8)
    rng = cv2.dilate(g, kernel) - cv2.erode(g, kernel)
    edge_limit = max(18.0, 3.0 * float(np.median(rng)))
    edges = (rng > edge_limit).astype(np.uint8)
    # The box blur spreads an edge over k pixels, so exclude that whole neighbourhood.
    near_edge = cv2.dilate(edges, np.ones((k, k), np.uint8))
    mask = (near_edge == 0).astype(np.float32)
    # Robust clip of whatever remains.
    sigma = 1.4826 * float(np.median(np.abs(res[mask > 0]))) + 0.75 if mask.any() else 1.0
    mask *= (np.abs(res) < 4.0 * sigma).astype(np.float32)
    return res * mask, mask


def _fold(res: np.ndarray, mask: np.ndarray) -> np.ndarray:
    h, w = res.shape
    ph, pw = -(-h // TILE) * TILE, -(-w // TILE) * TILE
    r = np.zeros((ph, pw), np.float64)
    m = np.zeros((ph, pw), np.float64)
    r[:h, :w] = res
    m[:h, :w] = mask
    folded = r.reshape(ph // TILE, TILE, pw // TILE, TILE).sum(axis=(0, 2))
    counts = m.reshape(ph // TILE, TILE, pw // TILE, TILE).sum(axis=(0, 2))
    return folded / np.maximum(counts, 1.0)


def _align(folded: np.ndarray, pilot_px: np.ndarray) -> tuple[int, int, float, float]:
    """Circular cross-correlation via FFT. Returns (dy, dx, peak, z-score)."""
    corr = np.real(np.fft.ifft2(np.fft.fft2(folded) * np.conj(np.fft.fft2(pilot_px))))
    idx = np.unravel_index(np.argmax(np.abs(corr)), corr.shape)
    peak = corr[idx]
    others = np.abs(corr).copy()
    others[idx] = 0
    z = (abs(peak) - others.mean()) / (others.std() + 1e-12)
    return int(idx[0]), int(idx[1]), float(peak), float(z)


def _chips_at(folded: np.ndarray, dy: int, dx: int) -> np.ndarray:
    aligned = np.roll(np.roll(folded, -dy, axis=0), -dx, axis=1)
    return aligned.reshape(CHIPS, CHIP, CHIPS, CHIP).sum(axis=(1, 3))


@dataclass
class Observation:
    chips: np.ndarray  # aligned chip correlations, polarity-corrected
    z: float
    scale: float
    sx: float = 1.0  # horizontal / vertical zoom actually used (for diagnostics)
    sy: float = 1.0
    dy: int = 0  # tile alignment offset
    dx: int = 0


STRONG_Z = 12.0
MIN_MATCH_SIGMA = 6.0  # one-sided false-match probability < 1e-9


def _period_profile(ac_line: np.ndarray, lo: int, hi: int) -> np.ndarray:
    seg = ac_line[: hi + 1].copy()
    # Remove the slowly-decaying content autocorrelation, keep sharp periodic peaks.
    base = ndimage.median_filter(seg, size=9)
    prof = seg - base
    prof[:lo] = -np.inf
    return prof


def _refine_with_harmonics(line: np.ndarray, p0: int, n: int) -> float:
    estimates, weights = [float(p0)], [1.0]
    k = 2
    while k * p0 + 3 < n // 2 and k <= 8:
        c = k * p0
        win = line[c - 3 : c + 4]
        j = int(np.argmax(win))
        if 0 < j < 6:
            y0, y1, y2 = win[j - 1], win[j], win[j + 1]
            denom = y0 - 2 * y1 + y2
            off = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
            estimates.append((c - 3 + j + off) / k)
            weights.append(float(k))
        k += 1
    return float(np.average(estimates, weights=weights))


def _candidate_scales(res: np.ndarray, per_axis: int = 3) -> tuple[list[float], list[float]]:
    """Candidate zoom factors per axis from the residual's autocorrelation.

    The watermark tile repeats every TILE*scale pixels, which shows up as sharp peaks in
    the autocorrelation at that lag. Content (e.g. text line spacing) can add other
    peaks, so the top few peaks on each axis are returned and tested. Axes are handled
    separately because captures are often stretched unevenly (resizes, photos)."""
    r = res - res.mean()
    ac = np.fft.irfft2(np.abs(np.fft.rfft2(r)) ** 2, s=r.shape)
    axes: list[list[float]] = []
    for line in (ac[0, :], ac[:, 0]):
        found: list[float] = []
        n = line.shape[0]
        lo, hi = int(TILE * 0.3), min(int(TILE * 3.2), n // 2 - 2)
        if hi > lo + 4:
            prof = _period_profile(line, lo, hi)
            for _ in range(per_axis):
                p0 = int(np.argmax(prof))
                if not np.isfinite(prof[p0]) or prof[p0] <= 0:
                    break
                sc = _refine_with_harmonics(line, p0, n) / TILE
                if all(abs(sc - u) / u > 0.01 for u in found):
                    found.append(sc)
                prof[max(0, p0 - 6) : p0 + 7] = -np.inf
        axes.append(found)
    return axes[0], axes[1]


def observe(gray: np.ndarray, key: bytes) -> Observation | None:
    """Locate the watermark tile in a grayscale image (any crop offset / zoom)."""
    p = pattern_for(key)
    pilot_px = np.kron(p.pilot, np.ones((CHIP, CHIP)))
    res, mask = _prep(gray)
    h, w = res.shape
    if h < TILE // 2 or w < TILE // 2:
        return None

    def at_scale(sx: float, sy: float) -> Observation | None:
        r, m = res, mask
        if sx != 1.0 or sy != 1.0:
            nh, nw = int(round(h / sy)), int(round(w / sx))
            if nh < TILE // 2 or nw < TILE // 2:
                return None
            interp = cv2.INTER_AREA if min(sx, sy) > 1 else cv2.INTER_LINEAR
            r = cv2.resize(res, (nw, nh), interpolation=interp)
            m = cv2.resize(mask, (nw, nh), interpolation=cv2.INTER_LINEAR)
        folded = _fold(r, m)
        dy, dx, peak, z = _align(folded, pilot_px)
        return Observation(chips=_chips_at(folded, dy, dx) * np.sign(peak), z=z, scale=round((sx + sy) / 2, 4), sx=sx, sy=sy, dy=dy, dx=dx)

    best = at_scale(1.0, 1.0)
    if best and best.z >= STRONG_Z:
        return best

    xs, ys = _candidate_scales(res)
    # Pair every x estimate with every y estimate (and with itself, for isotropic zoom).
    pairs = {(round(x, 4), round(y, 4)) for x in xs for y in ys} | {(x, x) for x in xs} | {(y, y) for y in ys}
    coarse: Observation | None = None
    coarse_xy = (1.0, 1.0)
    for sx, sy in pairs:
        o = at_scale(sx, sy)
        if o and (coarse is None or o.z > coarse.z):
            coarse, coarse_xy = o, (sx, sy)
    if coarse and (best is None or coarse.z > best.z):
        best = coarse
        # Coordinate descent: refine each axis independently around the best pair.
        sx, sy = coarse_xy
        for _ in range(2):
            for axis in (0, 1):
                for f in np.exp(np.linspace(-0.012, 0.012, 9)):
                    cx, cy = (sx * f, sy) if axis == 0 else (sx, sy * f)
                    o = at_scale(float(cx), float(cy))
                    if o and o.z > best.z:
                        best, sx, sy = o, float(cx), float(cy)
    return best


def decode_observations(obs: list[Observation], key: bytes) -> dict:
    p = pattern_for(key)
    usable = [o for o in obs if o is not None and o.z >= 5.0]
    if not usable:
        best_z = max((o.z for o in obs if o is not None), default=0.0)
        return {"found": False, "reason": "no watermark pilot detected", "pilot_z": round(best_z, 2)}
    # Weight observations by pilot strength and combine soft bits.
    soft = np.zeros(CODE_BITS)
    for o in usable:
        contrib = o.chips * p.chip_sign
        per_bit = np.bincount(p.chip_bit.ravel(), weights=contrib.ravel(), minlength=CODE_BITS)
        soft += per_bit / (np.abs(per_bit).mean() + 1e-12) * o.z
    wm_id, corrected = decode_payload(soft)
    margin = float(np.abs(soft).min() / (np.abs(soft).mean() + 1e-12))
    result = {
        "found": wm_id is not None,
        "wm_id": wm_id,
        "rs_corrected_bytes": corrected,
        "pilot_z": round(max(o.z for o in usable), 2),
        "pages_or_frames_used": len(usable),
        "scale": round(usable[0].scale, 3),
        "bit_margin": round(margin, 3),
    }
    if wm_id is None:
        result["reason"] = "pilot found but payload unrecoverable (too much damage)"
    else:
        # Re-check against the re-encoded payload. For a random (wrong) code word the
        # normalised correlation is ~N(0,1), so it reads directly as a sigma score.
        expected = encode_payload(wm_id)
        agree = float(np.mean(np.sign(soft) == expected))
        sigma = float(np.dot(soft, expected) / (np.linalg.norm(soft) + 1e-12))
        false_match_p = 0.5 * math.erfc(sigma / math.sqrt(2))
        result["bit_agreement"] = round(agree, 4)
        result["match_sigma"] = round(sigma, 2)
        result["false_match_probability"] = float(f"{false_match_p:.3g}")
        if sigma < MIN_MATCH_SIGMA or agree < 0.8:
            result["found"] = False
            result["wm_id"] = None
            result["reason"] = "decoded value is not statistically distinguishable from noise"
    return result


# ---------------------------------------------------------------- images


def load_rgb(data: bytes) -> tuple[np.ndarray, Image.Image]:
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    return np.asarray(im.convert("RGB")), im


def embed_image(data: bytes, key: bytes, wm_id: str) -> tuple[bytes, str]:
    rgb, original = load_rgb(data)
    marked = embed_array(rgb, key, wm_id)
    fmt = (original.format or "PNG").upper()
    out = io.BytesIO()
    has_alpha = original.mode in ("RGBA", "LA") or "transparency" in original.info
    result = Image.fromarray(marked)
    if fmt in ("JPEG", "JPG"):
        result.save(out, "JPEG", quality=95, subsampling=0, icc_profile=original.info.get("icc_profile"))
        return out.getvalue(), "image/jpeg"
    if has_alpha:
        alpha = original.convert("RGBA").split()[-1]
        result = result.convert("RGBA")
        result.putalpha(alpha)
    result.save(out, "PNG", optimize=True, icc_profile=original.info.get("icc_profile"))
    return out.getvalue(), "image/png"


def gray_of(rgb: np.ndarray) -> np.ndarray:
    return _luma(rgb.astype(np.float64))


def extract_image(data: bytes, key: bytes) -> dict:
    rgb, _ = load_rgb(data)
    return decode_observations([observe(gray_of(rgb), key)], key)

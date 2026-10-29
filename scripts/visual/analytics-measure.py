"""Measured checks for analytics hill-climb captures (tests/browser/analyticsHillclimb.browser.ts).

Usage: uv run --with pillow python scripts/visual/analytics-measure.py <capture-dir>
Text contrast and series colours are read from screenshot pixels; sizes and overflow from DOM.
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

# Thresholds fixed for the whole run (recorded before the first measurement).
TEXT, LARGE, NON_TEXT = 4.5, 3.0, 3.0
TARGET_DESKTOP, TARGET_TOUCH = 24, 44
SERIES_DELTA_E = 25  # colours sharing one chart
RESERVED_DELTA_E = 15  # versus Claude, Codex, success, failure inks
RESERVED = {
    "claude": (0xED, 0x98, 0x77),
    "codex": (0x83, 0xAD, 0xFF),
    "success": (0x34, 0xC5, 0x8F),
    "failure": (0xF2, 0x76, 0x6B),
}


def lum(rgb):
    v = [c / 255 for c in rgb]
    v = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in v]
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]


def ratio(a, b):
    x, y = sorted([lum(a), lum(b)])
    return (y + 0.05) / (x + 0.05)


def lab(rgb):
    v = [c / 255 for c in rgb]
    v = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in v]
    x = (0.4124 * v[0] + 0.3576 * v[1] + 0.1805 * v[2]) / 0.95047
    y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
    z = (0.0193 * v[0] + 0.1192 * v[1] + 0.9505 * v[2]) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))


def delta_e(a, b):
    return math.dist(lab(a), lab(b))


def pixels(im, box):
    x0, y0 = max(0, math.floor(box["x"])), max(0, math.floor(box["y"]))
    x1, y1 = min(im.width, math.ceil(box["x"] + box["w"])), min(im.height, math.ceil(box["y"] + box["h"]))
    if x1 <= x0 or y1 <= y0:
        return Counter()
    return Counter(im.crop((x0, y0, x1, y1)).get_flattened_data())


def measure(png, geo):
    im = Image.open(png).convert("RGB")
    touch = geo.get("touch", geo["pageWidth"] < 600)
    failures = []
    text_ratios, series_ratios, target_sizes, colour_distances = [], [], [], []
    for node in geo["text"]:
        if node["disabled"]:
            continue
        colors = pixels(im, node)
        if not colors:
            continue
        bg = colors.most_common(1)[0][0]
        fg = max(colors, key=lambda c: ratio(c, bg))
        need = LARGE if node["size"] >= 24 or (node["size"] >= 18.66 and node["weight"] >= 700) else TEXT
        text_ratios.append(ratio(fg, bg))
        if ratio(fg, bg) < need:
            failures.append(f"contrast {ratio(fg, bg):.2f}<{need} '{node['text']}'")
    minimum = TARGET_TOUCH if touch else TARGET_DESKTOP
    for c in geo["controls"]:
        # Chart buckets are pointer conveniences with a keyboard/table equivalent.
        if c["tag"] == "rect":
            continue
        target_sizes.append(min(c["w"], c["h"]))
        if min(c["w"], c["h"]) < minimum:
            failures.append(f"target {c['w']:.0f}x{c['h']:.0f}<{minimum} '{c['text']}'")
    if geo["scrollWidth"] > geo["pageWidth"]:
        failures.append(f"page overflow {geo['scrollWidth']}>{geo['pageWidth']}")
    for c in geo["clipped"]:
        failures.append(f"clipped {c['tag']} {c['class']}")
    series = []
    for s in geo["swatches"]:
        colors = pixels(im, s)
        if not colors:
            continue
        bg = colors.most_common(1)[0][0]
        ink = max(colors, key=lambda c: (ratio(c, bg), colors[c]))
        series.append((s["label"], ink, bg))
        series_ratios.append(ratio(ink, bg))
        if ratio(ink, bg) < NON_TEXT:
            failures.append(f"series contrast {ratio(ink, bg):.2f} '{s['label']}'")
        for name, ref in RESERVED.items():
            if delta_e(ink, ref) < RESERVED_DELTA_E:
                failures.append(f"series '{s['label']}' reads as {name} (dE {delta_e(ink, ref):.1f})")
    for i, (a, ia, _) in enumerate(series):
        for b, ib, _ in series[i + 1 :]:
            # Same-ink series (durations) are told apart by dash style, by design.
            if ia != ib:
                colour_distances.append(delta_e(ia, ib))
            if ia != ib and delta_e(ia, ib) < SERIES_DELTA_E:
                failures.append(f"series '{a}' vs '{b}' dE {delta_e(ia, ib):.1f}")
    toolbar_contrast = None
    toolbar = geo.get("toolbar")
    if toolbar:
        x, y = round(toolbar["x"] + toolbar["w"] / 2), round(toolbar["y"])
        if 2 <= y < im.height - 2 and 0 <= x < im.width:
            border, outside, inside = [im.getpixel((x, y + offset)) for offset in (0, -2, 2)]
            toolbar_contrast = min(ratio(border, outside), ratio(border, inside))
            if toolbar_contrast < NON_TEXT:
                failures.append(f"toolbar border contrast {toolbar_contrast:.2f}<{NON_TEXT}")
    minimum_or_none = lambda values: round(min(values), 2) if values else None
    return failures, {
        "minimum_text_contrast": minimum_or_none(text_ratios),
        "minimum_series_contrast": minimum_or_none(series_ratios),
        "minimum_target_px": minimum_or_none(target_sizes),
        "target_threshold_px": minimum,
        "minimum_distinct_series_delta_e": minimum_or_none(colour_distances),
        "horizontal_overflow_px": max(0, geo["scrollWidth"] - geo["pageWidth"]),
        "clipped_elements": len(geo["clipped"]),
        "toolbar_border_contrast": round(toolbar_contrast, 2) if toolbar_contrast else None,
    }


def main():
    root = Path(sys.argv[1])
    report = {}
    metrics = {}
    for png in sorted(root.rglob("*.png")):
        # Earlier rounds saved full-page geometry only; new rounds measure both.
        if png.parent.name == "fold" and not png.with_suffix(".json").exists():
            continue
        geo = json.loads(png.with_suffix(".json").read_text())
        key = str(png.relative_to(root).with_suffix(""))
        report[key], metrics[key] = measure(png, geo)
    (root / "measurements.json").write_text(json.dumps(report, indent=2) + "\n")
    (root / "measurement-values.json").write_text(json.dumps(metrics, indent=2) + "\n")
    for name, failures in report.items():
        print(f"{name}: {'PASS' if not failures else 'FAIL'}")
        for f in failures[:12]:
            print("   ", f)
    return 1 if any(report.values()) else 0


if __name__ == "__main__":
    sys.exit(main())

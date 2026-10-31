"""Repeatable browser fixtures for Prox UI review; never reads real credentials."""

import argparse
import asyncio
import colorsys
import json
import math
import time
from collections import Counter
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
NOW = 1793102400000
DAY = 86_400_000


NAMES = ["ada.lovelace", "grace.hopper", "alan.turing", "edsger.dijkstra", "katherine.johnson",
         "margaret.hamilton", "dorothy.vaughan", "barbara.liskov", "donald.knuth", "linus.torvalds"]


def mask(provider, i):
    """Same shape as server/quota/mask.ts: first two characters, last one, domain initial."""
    name = NAMES[(i + (0 if provider == "claude" else 5)) % len(NAMES)] + (str(i // len(NAMES) or "") if i >= len(NAMES) else "")
    return f"{name[:3]}•••{name[-2:]}@ex•••.test"


def fixture(state):
    """Synthetic, precomputed API contract examples, not production forecasts."""
    pools = []
    # "many" is 200 accounts, to show how long rosters read; every other state keeps the small pair.
    sizes = (120, 80) if state.startswith("many") else (3, 2)
    for provider, count, scale in [("claude", sizes[0], sizes[0] / 3), ("codex", sizes[1], sizes[1] / 2)]:
        # A larger roster scales every amount, so its rates and projection agree with its balance.
        remaining = (248.4 if provider == "claude" else 142.8) * scale
        burn = (3.7 if provider == "claude" else 2.7) * scale

        def point(at, value):
            return dict(
                atMs=at,
                remainingPoints=value,
                burnPointsPerHour=burn,
                drainPointsPerHour=burn,
            )

        recorded = [
            point(NOW - DAY * (3 - i / 8), remaining + (24 - i) * 1.3 * scale)
            for i in range(25)
        ]
        projected = [
            point(NOW, remaining),
            point(NOW + DAY, remaining - 75 * scale),
            point(NOW + DAY, remaining + 25 * scale),
            point(NOW + 4 * DAY, (30 if provider == "claude" else 18) * scale),
            point(NOW + 4 * DAY, (130 if provider == "claude" else 118) * scale),
            point(NOW + 7 * DAY, (10 if provider == "claude" else 4) * scale),
        ]
        accounts = [
            dict(
                id=f"{provider}-{i}",
                label=f"{provider.title()} {i + 1}",
                identifier=mask(provider, i),
                disabled=False,
                status="ok",
                observedAtMs=NOW,
                remainingPercent=round(remaining / count, 1),
                resetAtMs=NOW + DAY * (i + 1),
                burnPointsPerHour=burn / count,
                emptyAtMs=NOW + DAY * (2 + i),
                plan=dict(
                    label="Pro" if provider == "claude" else "Plus",
                    capacityPoints=100,
                    known=True,
                ),
                windows=[
                    dict(id="five-hour", labelKey="claude_quota.five_hour" if provider == "claude" else "codex_quota.primary_window",
                         remainingPercent=[62, 14, 88][i % 3], resetAtMs=NOW + 3_600_000 * (i + 1)),
                    dict(id="seven-day" if provider == "claude" else "weekly",
                         labelKey="claude_quota.seven_day" if provider == "claude" else "codex_quota.secondary_window",
                         remainingPercent=round(remaining / count, 1), resetAtMs=NOW + DAY * (i + 1)),
                ] + ([dict(id="seven-day-opus", labelKey="claude_quota.seven_day_opus",
                           remainingPercent=45, resetAtMs=None)] if provider == "claude" else []),
            )
            for i in range(count)
        ]
        pool = dict(
            provider=provider,
            accountCount=count,
            eligibleCount=count,
            loadedCount=count,
            capacityPoints=count * 100,
            remainingPoints=remaining,
            burnPointsPerHour=burn,
            drainPointsPerHour=burn,
            forecastState="ready",
            firstEmptyAtMs=NOW + 2 * DAY,
            poolEmptyAtMs=None,
            nextResetAtMs=NOW + DAY,
            nextResetGainPoints=100 * scale,
            recorded=recorded,
            projected=projected,
            resets=[
                dict(atMs=NOW + DAY, gainPoints=100 * scale),
                dict(atMs=NOW + 4 * DAY, gainPoints=100 * scale),
            ],
            accounts=accounts,
        )
        if state in ("partial", "stale", "collecting"):
            pool.update(
                forecastState=state,
                projected=[],
                firstEmptyAtMs=None,
                poolEmptyAtMs=None,
                burnPointsPerHour=None,
                drainPointsPerHour=None,
                resets=[],
                nextResetGainPoints=None,
            )
            if state != "collecting":
                pool.update(remainingPoints=None, loadedCount=count - 1)
                recorded[-1] = dict(recorded[-1], remainingPoints=None, burnPointsPerHour=None,
                                    drainPointsPerHour=None)
                accounts[-1].update(
                    status="stale" if state == "stale" else "error",
                    remainingPercent=accounts[-1]["remainingPercent"] if state == "stale" else None,
                    burnPointsPerHour=None,
                    emptyAtMs=None,
                )
                if state != "stale":
                    accounts[-1]["windows"] = [
                        dict(limit, remainingPercent=None, resetAtMs=None) if limit["id"] in ("seven-day", "weekly")
                        else limit for limit in accounts[-1]["windows"]
                    ]
                if state == "stale":
                    accounts[-1]["observedAtMs"] = NOW - 3_600_000
            if state == "collecting":
                pool["recorded"] = [point(NOW, remaining)]
        if state == "long":
            accounts[0]["label"] = (
                "A deliberately long credential label for a shared development workstation"
            )
            accounts[1].update(status="missing-window", remainingPercent=None,
                               burnPointsPerHour=None, emptyAtMs=None)
            # The missing window is the weekly one, so its limit has no value either.
            accounts[1]["windows"] = [
                dict(limit, remainingPercent=None, resetAtMs=None) if limit["id"] in ("seven-day", "weekly")
                else limit for limit in accounts[1]["windows"]
            ]
            # Match server/quota/domain.ts: a required missing window withholds
            # totals and projections. Keep the row and its missing-data meaning.
            pool.update(forecastState="partial", loadedCount=count - 1,
                        remainingPoints=None, burnPointsPerHour=None, drainPointsPerHour=None,
                        projected=[], resets=[], firstEmptyAtMs=None, poolEmptyAtMs=None,
                        nextResetGainPoints=None)
            recorded[-1] = dict(recorded[-1], remainingPoints=None, burnPointsPerHour=None,
                                drainPointsPerHour=None)
        pools.append(pool)
    if state in ("ultra", "no-limit"):
        # Anthropic removed the 5-hour limit for verified Ultra accounts (2026-10-30): the third
        # Claude account is Ultra and reports no 5-hour window; the 5-hour pool leaves it out.
        ultra = pools[0]["accounts"][2]
        ultra["plan"] = dict(label="Ultra", capacityPoints=2000, known=True)
        ultra["windows"] = [w for w in ultra["windows"] if w["id"] != "five-hour"]
        ultra["noFiveHourLimit"] = True
        if state == "ultra":
            # Weekly: the Ultra account still counts, at its 2,000-point weight (82.8% of 2,200).
            f = 1821.6 / 248.4
            pools[0].update(capacityPoints=2200, remainingPoints=1821.6,
                            nextResetGainPoints=pools[0]["nextResetGainPoints"] * f,
                            resets=[dict(r, gainPoints=r["gainPoints"] * f) for r in pools[0]["resets"]])
            for series in ("recorded", "projected"):
                pools[0][series] = [dict(item, remainingPoints=item["remainingPoints"] * f)
                                    for item in pools[0][series]]
        if state == "no-limit":
            ultra.update(status="no-limit", remainingPercent=None, resetAtMs=None,
                         burnPointsPerHour=None, emptyAtMs=None)
            pools[0].update(eligibleCount=2, loadedCount=2, capacityPoints=200)
            # In the 5-hour view each account's own percentage is its 5-hour one (62% and 14%),
            # so both pools hold 76 of 200 points.
            for pool in pools:
                for account, percent in zip(pool["accounts"], (62, 14)):
                    account["remainingPercent"] = percent
                for series in ("recorded", "projected"):
                    for item in pool[series]:
                        item["remainingPoints"] = item["remainingPoints"] * 76 / pool["remainingPoints"]
                pool["remainingPoints"] = 76
                # 5-hour windows reset within hours: the next one returns ada's used 38 points.
                pool.update(nextResetAtMs=NOW + 3_600_000, nextResetGainPoints=38,
                            resets=[dict(atMs=NOW + 3_600_000, gainPoints=38),
                                    dict(atMs=NOW + 7_200_000, gainPoints=86)])
                pool["projected"] = [
                    dict(pool["projected"][0], atMs=at, remainingPoints=value)
                    for at, value in [(NOW, 76), (NOW + 3_600_000, 75), (NOW + 3_600_000, 113),
                                      (NOW + 7_200_000, 112), (NOW + 7_200_000, 198), (NOW + 7 * DAY, 150)]
                ]
    # Precomputed synthetic total; domain arithmetic is exercised separately in Bun tests.
    k = sum(sizes) / 5  # the five-account totals below, scaled to the roster
    total = dict(capacityPoints=500 * k, remainingPoints=391.2 * k, burnPointsPerHour=6.4 * k,
                 drainPointsPerHour=6.4 * k, forecastState="ready", poolEmptyAtMs=None,
                 resets=[dict(atMs=NOW+DAY,gainPoints=200 * k)],
                 recorded=[dict(atMs=at, remainingPoints=value, burnPointsPerHour=6.4 * k,
                                drainPointsPerHour=6.4 * k) for at,value in [(NOW-DAY,412 * k),(NOW,391.2 * k)]],
                 projected=[dict(atMs=at, remainingPoints=value, burnPointsPerHour=None,
                                 drainPointsPerHour=None) for at,value in
                            [(NOW,391.2 * k),(NOW+DAY,241.2 * k),(NOW+DAY,441.2 * k),
                             (NOW+4*DAY,60 * k),(NOW+4*DAY,260 * k),(NOW+7*DAY,20 * k)]])
    if state == "ultra":
        f = 1821.6 / 248.4
        total.update(capacityPoints=2400, remainingPoints=1964.4)
        total["recorded"] = [dict(item, remainingPoints=value) for item, value in
                             zip(total["recorded"], (258.8 * f + 153.2, 1964.4))]
        total["projected"] = [dict(item, remainingPoints=item["remainingPoints"] * 1964.4 / 391.2)
                              for item in total["projected"]]
    if state == "no-limit":
        total.update(capacityPoints=400, remainingPoints=152)
        total["recorded"] = [dict(item, remainingPoints=value) for item, value in zip(total["recorded"], (160, 152))]
        total["projected"] = [dict(item, remainingPoints=item["remainingPoints"] * 152 / 391.2) for item in total["projected"]]
    if state in ("partial","stale","collecting","long"):
        total.update(forecastState="partial" if state=="long" else state, projected=[],resets=[])
        if state!="collecting": total.update(remainingPoints=None,burnPointsPerHour=None,drainPointsPerHour=None)
    layers=[]
    previous_values=([80,80] if state=="no-limit" else [258.8 * 1821.6 / 248.4,153.2] if state=="ultra"
                     else [258.8 * sizes[0] / 3,153.2 * sizes[1] / 2])
    for pool,previous in zip(pools,previous_values):
        layer={key:pool[key] for key in total}
        layer["provider"]=pool["provider"]
        layer["recorded"]=[dict(atMs=at,remainingPoints=value,burnPointsPerHour=pool["burnPointsPerHour"],
                                drainPointsPerHour=pool["drainPointsPerHour"])
                           for at,value in [(NOW-DAY,previous),(NOW,pool["remainingPoints"])]]
        if state=="collecting":layer["recorded"]=layer["recorded"][-1:]
        layers.append(layer)
    if state=="collecting":total["recorded"]=total["recorded"][-1:]
    if state in ("partial","stale","long"):
        total["recorded"][-1].update(remainingPoints=None,burnPointsPerHour=None,drainPointsPerHour=None)
    combined = {"all":dict(series=total,layers=layers,unavailableReason=None)}
    combined.update({layer["provider"]:dict(series={key:layer[key] for key in total},layers=[layer],unavailableReason=None) for layer in layers})
    if state == "stacked-unavailable": combined["all"] = dict(series=None,unavailableReason="ambiguous-sources")
    return dict(
        combined=combined,
        nowMs=NOW,
        fromMs=NOW - 3 * DAY,
        toMs=NOW + 7 * DAY,
        window="five-hour" if state == "no-limit" else "weekly",
        lookbackHours=3,
        multiplier=1,
        historyStartedAtMs=NOW - 3 * DAY,
        lastRefreshAtMs=NOW,
        nextRefreshAtMs=NOW + 300000,
        refreshing=False,
        issues=[],
        pools=[] if state == "empty" else pools,
    )


GEOMETRY = r"""(providedRoot) => {
  const root=providedRoot||document.querySelector('[class*="QuotaPoolPage"][class*="__page___"]');
  const origin=providedRoot?root.getBoundingClientRect():{x:-scrollX,y:-scrollY};
  const visible=e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden'&&e.checkVisibility({checkVisibilityCSS:true});};
  const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x-origin.x,y:b.y-origin.y,w:b.width,h:b.height};};
  const controls=[...root.querySelectorAll('button,select,input,summary,a')].filter(visible).map(e=>{
    const target=e.matches('input[type=checkbox]') ? e.closest('label') : e;
    return {text:(e.getAttribute('aria-label')||e.textContent||e.getAttribute('type')||'').trim().slice(0,100),...rect(target),disabled:e.matches(':disabled')};});
  const clipped=[...root.querySelectorAll('*')].filter(e=>visible(e)&&e.clientWidth>2&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>({tag:e.tagName,class:e.className,client:e.clientWidth,scroll:e.scrollWidth}));
  // Sample each painted text run, including nested names, balances and warnings.
  // Parent boxes can contain several colours and incorrectly credit a dim label
  // with the contrast of a brighter child.
  const text=[];
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()) {
    const node=walker.currentNode,e=node.parentElement;
    // Visually hidden text is never painted, so it has no contrast to measure.
    if(!e||!node.textContent.trim()||!visible(e)||e.closest('[class*="__srOnly___"]')||getComputedStyle(e).clipPath.startsWith('inset(50%'))continue;
    const s=getComputedStyle(e),range=document.createRange();range.selectNodeContents(node);
    for(const b of range.getClientRects()) {
      if(b.width<=2||b.height<=2)continue;
      text.push({text:node.textContent.trim().slice(0,90),x:b.x-origin.x,y:b.y-origin.y,w:b.width,h:b.height,
        size:parseFloat(s.fontSize),weight:parseInt(s.fontWeight)||400,
        disabled:!!e.closest(':disabled')||!!e.closest('label:has(input:disabled)'),tag:e.tagName});
    }
  }
  const charts=[...root.querySelectorAll('article')].filter(e=>e.querySelector('svg[role=img]')&&visible(e.querySelector('svg[role=img]'))).map(e=>{
    const svg=e.querySelector('svg[role=img]'), matrix=svg.getScreenCTM();
    const screen=(x,y)=>{const p=new DOMPoint(x,y).matrixTransform(matrix);return {x:p.x-origin.x,y:p.y-origin.y};};
    const strokePoints=[...svg.querySelectorAll('path[stroke]')].flatMap(path=>Array.from({length:11},(_,i)=>{const p=path.getPointAtLength(path.getTotalLength()*i/10);return screen(p.x,p.y);}));
    for(const c of svg.querySelectorAll('circle')) strokePoints.push(screen(c.cx.baseVal.value,c.cy.baseVal.value));
    return {provider:e.querySelector('h2')?.textContent?.toLowerCase(),...rect(svg),strokePoints};
  });
  const guides=[...root.querySelectorAll('ul[aria-label="Limits"]')].filter(e=>visible(e)&&parseFloat(getComputedStyle(e).borderInlineStartWidth)>0).map(rect);
  // Colours that carry meaning, sampled from pixels by measure(): error icon, Low chip, status dots, limit bars.
  const kindOf=e=>/__errorIcon___/.test(e.getAttribute('class')||'')?'error':/__limitWarning___/.test(e.className)?'low':/__limitBar___/.test(e.parentElement.className)?'bar':'status';
  const marks=[...root.querySelectorAll('[class*="__errorIcon___"],[class*="__limitWarning___"],[class*="__limitBar___"] > span')].filter(visible).map(e=>{
    const article=e.closest('article');const provider=article&&/__claude___/.test(article.className)?'claude':article&&/__codex___/.test(article.className)?'codex':null;
    return {kind:kindOf(e),provider,low:!!e.closest('[data-low="true"]'),...rect(e)};});
  return {marks,pageWidth:providedRoot?root.clientWidth:document.documentElement.clientWidth,pageScrollWidth:providedRoot?root.scrollWidth:document.documentElement.scrollWidth,controls,clipped,text,charts,guides};
}"""


def lum(rgb):
    values = [v / 255 for v in rgb]
    values = [
        v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values
    ]
    return sum(v * w for v, w in zip(values, [0.2126, 0.7152, 0.0722]))


def ratio(a, b):
    values = sorted([lum(a), lum(b)])
    return (values[1] + 0.05) / (values[0] + 0.05)


def pixels(im, box):
    x, y, w, h = [box[k] for k in ("x", "y", "w", "h")]
    if w < 1 or h < 1:
        return Counter()
    bounds = (
        max(0, math.floor(x)),
        max(0, math.floor(y)),
        min(im.width, math.ceil(x + w)),
        min(im.height, math.ceil(y + h)),
    )
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        return Counter()
    return Counter(im.crop(bounds).get_flattened_data())


def measure(path, geo, touch):
    im = Image.open(path).convert("RGB")
    readings = []
    for node in geo["text"]:
        if node["disabled"]:
            continue
        # A viewport fold is not a clipped label; measure only complete painted glyph boxes.
        if node["y"] < 0 or node["y"] + node["h"] > im.height:
            continue
        colors = pixels(im, node)
        if not colors:
            continue
        bg = colors.most_common(1)[0][0]
        fg = max(colors, key=lambda c: ratio(c, bg))
        required = (
            3
            if node["size"] >= 24 or (node["size"] >= 18.66 and node["weight"] >= 700)
            else 4.5
        )
        reading = {
            **node,
            "foreground": fg,
            "background": bg,
            "contrast": round(ratio(fg, bg), 2),
            "required": required,
        }
        # Hidden helpers do not have a readable painted box.
        if node["w"] > 2 and node["h"] > 2:
            readings.append(reading)
    semantic = []
    for box in geo["charts"]:
        colors = pixels(im, box)
        if not colors:
            continue
        bg = colors.most_common(1)[0][0]
        stroke_colors = Counter()
        for point in box.get("strokePoints", []):
            if 0 <= point["x"] < im.width and 0 <= point["y"] < im.height:
                stroke_colors.update(
                    pixels(im, dict(x=point["x"] - 2, y=point["y"] - 2, w=5, h=5))
                )
        # Older baseline captures have no geometry samples; those measurements
        # remain manual rather than guessing a series colour from text fringes.
        choices = []
        for rgb, n in stroke_colors.items():
            h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
            if s >= 0.4 and v >= 0.35:
                choices.append((n, rgb, h * 360, s))
        if choices:
            n, rgb, h, s = max(choices)
            semantic.append(
                dict(
                    provider=box["provider"],
                    rgb=rgb,
                    hue=round(h, 1),
                    saturation=round(s, 2),
                    contrast=round(ratio(rgb, bg), 2),
                )
            )
    # Meaning-carrying colours, held for the whole run: the error ink and the "Low" ink must read as red
    # (hue within 15 deg of 0) and sit at least dE 25 from the Claude coral; provider bars keep the
    # provider hues; every ink reaches 3:1 against what it sits on; healthy bars stay dE 25 from "Low".
    inks = []
    for mk in geo.get("marks", []):
        box = pixels(im, mk)
        if not box:
            continue
        dominant = box.most_common(1)[0][0]
        if mk["kind"] == "bar":
            ink, ground = dominant, im.getpixel((max(0, round(mk["x"] + mk["w"] + 3)), round(mk["y"] + mk["h"] / 2))) if mk["x"] + mk["w"] + 3 < im.width else dominant
            if ink == ground:  # bar fills its track; compare with the card behind it instead
                ground = im.getpixel((max(0, round(mk["x"])), max(0, round(mk["y"] - 6))))
        else:
            ink = max((c for c, n in box.items() if n >= 2), key=lambda c: (ratio(c, dominant), box[c]), default=dominant)
            ground = dominant
        h, s_, v = colorsys.rgb_to_hsv(*(c / 255 for c in ink))
        inks.append(dict(kind=mk["kind"], provider=mk["provider"], low=mk["low"], rgb=ink, hue=round(h * 360, 1),
                         contrast=round(ratio(ink, ground), 2)))
    ink_failures = []
    def lab(rgb):
        v = [c / 255 for c in rgb]
        v = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in v]
        x, y, z = (0.4124*v[0]+0.3576*v[1]+0.1805*v[2])/0.95047, 0.2126*v[0]+0.7152*v[1]+0.0722*v[2], (0.0193*v[0]+0.1192*v[1]+0.9505*v[2])/1.08883
        f = lambda t: t ** (1/3) if t > 0.008856 else 7.787*t + 16/116
        return (116*f(y)-16, 500*(f(x)-f(y)), 200*(f(y)-f(z)))
    dE = lambda a_, b_: math.dist(lab(a_), lab(b_))
    warn = next((i["rgb"] for i in inks if i["kind"] == "low"), None)
    for i in inks:
        if i["contrast"] < 3:
            ink_failures.append(dict(why="ink contrast < 3", **i))
        if i["kind"] in ("error", "low") and not (i["hue"] >= 345 or i["hue"] <= 15):
            ink_failures.append(dict(why=f"{i['kind']} ink is not red", **i))
        if i["kind"] == "bar" and not i["low"]:
            lo, hi = (10, 35) if i["provider"] == "claude" else (205, 235)
            if not lo <= i["hue"] <= hi:
                ink_failures.append(dict(why="provider bar left its hue band", **i))
            if warn and dE(i["rgb"], warn) < 25:
                ink_failures.append(dict(why="healthy bar within dE 25 of the Low ink", **i))
    err = next((i["rgb"] for i in inks if i["kind"] == "error"), None)
    claude_ink = next((i["rgb"] for i in inks if i["kind"] == "bar" and i["provider"] == "claude" and not i["low"]), (0xED, 0x98, 0x77))
    for name, ink in (("error", err), ("low", warn)):
        if ink and dE(ink, claude_ink) < 25:
            ink_failures.append(dict(why=f"{name} ink within dE 25 of the Claude coral"))
    target = 44 if touch else 24
    semantic_failures = []
    for color in semantic:
        lo, hi = (10, 35) if color["provider"] == "claude" else (205, 235)
        if not lo <= color["hue"] <= hi or color["contrast"] < 3:
            semantic_failures.append(color)
    hues = {color["provider"]: color["hue"] for color in semantic}
    separation = None
    if "claude" in hues and "codex" in hues:
        distance = abs(hues["claude"] - hues["codex"])
        separation = min(distance, 360 - distance)
        if separation < 120:
            semantic_failures.append({"hueSeparation": separation})
    guide_readings = []
    for box in geo.get("guides", []):
        x, y = round(box["x"]), round(box["y"] + box["h"] / 2)
        # Off-viewport account content is measured again in its section crop.
        if not (2 <= x < im.width and 0 <= y < im.height):
            continue
        guide_readings.append(dict(**box, contrast=round(ratio(im.getpixel((x, y)), im.getpixel((x - 2, y))), 2)))
    return dict(
        **geo,
        guideContrast=guide_readings,
        guideFailures=[g for g in guide_readings if g["contrast"] < 3],
        contrast=readings,
        semanticColors=semantic,
        semanticFailures=semantic_failures,
        inks=inks,
        inkFailures=ink_failures,
        hueSeparation=separation,
        targetMinimum=target,
        targetFailures=[
            c
            for c in geo["controls"]
            if not c["disabled"] and (c["w"] < target - 0.1 or c["h"] < target - 0.1)
        ],
        contrastFailures=[r for r in readings if r["contrast"] < r["required"]],
        nestingFailures=[geo["grouping"]["nesting"]] if geo["grouping"]["nesting"]["fails"] else [],
        hiddenReasonFailures=geo["grouping"]["hiddenReason"],
        pageOverflow=geo["pageScrollWidth"] > geo["pageWidth"],
    )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:15173")
    ap.add_argument("--cases", nargs="*")
    ap.add_argument("--minimize-cards", action="store_true")
    ap.add_argument("--capture-only", action="store_true")
    ap.add_argument("--assert-compact", action="store_true")
    ap.add_argument("--compact-baseline", help="Evidence round whose account geometry must be preserved")
    args = ap.parse_args()
    out = ROOT / "docs/evidence/hillclimb" / args.round
    out.mkdir(parents=True, exist_ok=True)
    cases = [
        ("wide", "ready", 1920, 1280),
        ("laptop", "ready", 1280, 900),
        ("narrow", "ready", 390, 844),
        ("empty", "empty", 1440, 900),
        ("loading", "loading", 1440, 900),
        ("error", "error", 1440, 900),
        ("partial", "partial", 1440, 1000),
        ("stale", "stale", 1440, 1000),
        ("collecting", "collecting", 1440, 1000),
        ("long-narrow", "long", 390, 844),
        ("details-narrow", "details", 390, 844),
        ("expanded", "expanded", 1920, 1280),
        ("expanded-narrow", "expanded", 390, 844),
        ("drain", "drain", 1440, 1000),
        ("burn-narrow", "burn", 390, 844),
        ("refresh-error", "refresh-error", 1440, 1000),
        ("refresh-pending", "refresh-pending", 1440, 1000),
        ("ultra", "ultra", 1440, 1000),
        ("no-limit", "no-limit", 1440, 1000),
        ("no-limit-narrow", "no-limit", 390, 844),
        ("many", "many", 1440, 1000),
        ("many-narrow", "many", 390, 844),
        ("many-lowest", "many-lowest", 1440, 1000),
        ("many-search-narrow", "many-search", 390, 844),
        ("many-low", "many-low", 1440, 1000),
        ("empty-narrow", "empty", 390, 844),
        ("loading-narrow", "loading", 390, 844),
        ("error-narrow", "error", 390, 844),
        ("partial-narrow", "partial", 390, 844),
        ("stale-narrow", "stale", 390, 844),
        ("collecting-narrow", "collecting", 390, 844),
        ("refresh-pending-narrow", "refresh-pending", 390, 844),
        ("stacked-wide", "stacked", 1920, 1280),
        ("stacked-narrow", "stacked", 390, 844),
        ("stacked-unavailable", "stacked-unavailable", 1440, 1000),
    ]
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=str(
                Path.home() / ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
            ),
            headless=True,
            args=["--no-sandbox"],
        )
        saved = out / "measurements.json"
        results = json.loads(saved.read_text()) if args.cases and saved.exists() else {}
        try:
            for name, state, width, height in cases:
                if args.cases and name not in args.cases:
                    continue
                context = await browser.new_context(
                    viewport=dict(width=width, height=height),
                    device_scale_factor=1,
                    is_mobile=width < 600,
                    has_touch=width < 600,
                    locale="en-US",
                    timezone_id="UTC",
                    color_scheme="dark",
                    reduced_motion="reduce",
                )
                page = await context.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))

                pending_until = 0
                collection_requests = 0

                async def route_api(route):
                    nonlocal pending_until, collection_requests
                    url = route.request.url
                    if "/prox/pools" in url:
                        if state == "loading":
                            await asyncio.sleep(20)
                            await route.abort()
                            return
                        if state == "error":
                            await route.fulfill(
                                status=503, json={"error": "Fixture unavailable"}
                            )
                            return
                        data = fixture(state)
                        if state == "refresh-pending":
                            data["refreshing"] = time.monotonic() < pending_until
                        await route.fulfill(json=data)
                        return
                    if "/prox/refresh" in url:
                        collection_requests += 1
                        if state == "refresh-pending":
                            pending_until = time.monotonic() + 6
                            await route.fulfill(json={**fixture("ready"), "refreshing": True})
                            return
                        await route.fulfill(
                            status=503 if state == "refresh-error" else 200,
                            json=fixture("ready"),
                        )
                        return
                    if "/config" in url:
                        await route.fulfill(json={})
                        return
                    await route.fulfill(json={})

                await page.route("**/v8/management/**", route_api)
                await page.goto(args.url, wait_until="networkidle")
                await page.evaluate("""async () => {
                    const {useAuthStore}=await import('/src/stores/useAuthStore.ts');
                    const {apiClient}=await import('/src/services/api/client.ts');
                    const i18n=(await import('/src/i18n/index.ts')).default; await i18n.changeLanguage('en');
                    apiClient.setConfig({apiBase:location.origin,managementKey:'visual-fixture-only'});
                    useAuthStore.setState({isAuthenticated:true,connectionStatus:'connected',apiBase:location.origin,managementKey:'visual-fixture-only'});
                    location.hash='/quota';
                }""")
                try:
                    await page.locator('[class*="QuotaPoolPage"][class*="__page___"]').wait_for()
                except Exception:
                    print("Fixture navigation failed", name, page.url, errors, flush=True)
                    await page.screenshot(path=str(out / "navigation-error.png"),full_page=True)
                    raise
                assert await page.title() == "Prox"
                if state in ("error", "loading", "empty"):
                    await page.locator(
                        '[role="alert"]'
                        if state == "error"
                        else '[class*="__loading___"]'
                        if state == "loading"
                        else '[class*="__notice___"]'
                    ).last.wait_for()
                else:
                    await page.locator("article").first.wait_for()
                grouping_src = (Path.home() / ".claude-cliproxy/skills/hillclimb-ui/grouping-checks.js").read_text()
                loaded_checks = await page.evaluate(f"{grouping_src};groupingChecks({{ root: '.content' }})")
                if state in ("stacked", "stacked-unavailable"):
                    view = page.get_by_role("combobox", name="Chart view", exact=True)
                    combined = page.get_by_role("region",name="Combined usage",exact=True)
                    if state == "stacked":
                        await view.select_option("stacked")
                        assert await combined.locator('svg [data-stack-band="recorded"]').count() == 2
                        assert await combined.locator('svg [data-series="total"]').count() == 0
                    else:
                        # Nothing to stack: the option is off, provider lines are drawn, and the reason shows.
                        assert await view.locator('option[value="stacked"]').evaluate("o => o.disabled"), await view.inner_html()
                        assert await combined.locator('svg[role="img"]').count() == 1
                        assert "unverified account overlap" in await combined.inner_text()
                if state in ("drain", "burn"):
                    await page.get_by_role(
                        "button",
                        name="Drain rate" if state == "drain" else "Burn rate",
                        exact=True,
                    ).click()
                if state == "no-limit":
                    await page.get_by_role("button", name="5-hour", exact=True).click()
                if state == "details":
                    await (
                        page.locator('details[class*="__account___"]')
                        .first.locator("summary")
                        .click()
                    )
                if state == "many-lowest":
                    await page.get_by_role("combobox", name="Sort accounts").first.select_option("lowest")
                if state == "many-low":
                    await page.get_by_role("button", name="40 low").first.click()
                if state == "many-search":
                    await page.get_by_role("searchbox", name="Search accounts").first.fill("gra")
                if state == "expanded":
                    # Each click renames its button to "Collapse all", so always take the first still closed.
                    for _ in range(await page.get_by_role("button", name="Expand all").count()):
                        await page.get_by_role("button", name="Expand all").first.click()
                    # The footnote disclosure holds background; this capture shows every disclosure open.
                    await page.locator('details[class*="__about___"]').evaluate_all("nodes => nodes.forEach(n => { n.open = true; })")
                if state == "refresh-error":
                    await page.locator('.header-actions button').first.click()
                    await page.locator('[class*="QuotaPoolPage"] [role="alert"]').wait_for()
                    # Header refresh also raises a dismissible toast. Verify it, then
                    # capture the persistent page state without its temporary overlay.
                    toast = page.locator('[class*="NotificationContainer"] button[aria-label="Close"]')
                    await toast.click()
                    await toast.wait_for(state="hidden")
                refresh_started = None
                if state == "refresh-pending":
                    refresh_started = time.monotonic()
                    await page.locator('.header-actions button').first.click()
                    await page.locator('[class*="__countdown___"]').filter(has_text="Refreshing").wait_for()
                    # The header refresh raises a transient success toast; capture the persistent page state.
                    toast = page.locator('[class*="NotificationContainer"] button[aria-label="Close"]')
                    await toast.click()
                    await toast.wait_for(state="hidden")
                # Baseline charts are disclosures; capture their expanded state too.
                if state in ("drain", "burn"):
                    await page.locator('details[class*="__forecast___"]').evaluate_all(
                        "(nodes)=>nodes.forEach(n=>n.open=true)"
                    )
                if args.minimize_cards:
                    for button in await page.locator('button[class*="__graphToggle___"]').all():
                        await button.click()
                await page.evaluate("document.fonts.ready")
                await page.wait_for_timeout(350)
                # The shell scrolls `.content` inside a 100vh frame, so a full-page shot stops at the
                # fold. Save that first screen, then grow the viewport until the whole page is painted.
                await page.mouse.move(0, 0)
                (out / "fold").mkdir(exist_ok=True)
                await page.screenshot(path=str(out / "fold" / f"{name}.png"), animations="disabled")
                for _ in range(3):
                    hidden = await page.evaluate(
                        "() => { const c = document.querySelector('.content'); return c ? c.scrollHeight - c.clientHeight : 0; }"
                    )
                    if hidden <= 0:
                        break
                    await page.set_viewport_size(
                        dict(width=width, height=min(15000, page.viewport_size["height"] + hidden))
                    )
                    await page.wait_for_timeout(250)
                path = out / f"{name}.png"
                await page.screenshot(
                    path=str(path), full_page=True, animations="disabled"
                )
                geo = await page.evaluate(GEOMETRY)
                # Hidden reason: as loaded, except states reached by an interaction, which are read once open.
                now_checks = await page.evaluate(f"{grouping_src};groupingChecks({{ root: '.content' }})")
                hidden_reason = loaded_checks["hiddenReason"] if state in ("expanded", "details") else now_checks["hiddenReason"]
                geo["grouping"] = dict(nesting=now_checks["nesting"], hiddenReason=hidden_reason)
                results[name] = dict(
                    state=state,
                    viewport=[width, height],
                    errors=errors,
                    **measure(path, geo, width < 600),
                )
                if args.capture_only:
                    accounts = page.locator('article section[class*="__accounts___"]').first
                    if await accounts.count():
                        await accounts.screenshot(path=str(out / f"{name}-accounts.png"), animations="disabled")
                        results[name]["accountsHeight"] = (await accounts.bounding_box())["height"]
                        results[name]["accountSections"]=[]
                        results[name]["accountMeasurements"]=[]
                        for index, section in enumerate(await page.locator('article section[class*="__accounts___"]').all()):
                            await section.screenshot(path=str(out / f"{name}-provider-{index}-accounts.png"), animations="disabled")
                            results[name]["accountMeasurements"].append(measure(out / f"{name}-provider-{index}-accounts.png", await section.evaluate(GEOMETRY), width < 600))
                            results[name]["accountSections"].append(await section.evaluate("""section => ({
                                height:section.getBoundingClientRect().height,
                                rows:[...section.querySelectorAll('details')].map(row=>({
                                    height:row.getBoundingClientRect().height,
                                    name:row.querySelector('[class*="__accountName___"]').firstChild.textContent,
                                    nameHeight:row.querySelector('[class*="__accountName___"]').getBoundingClientRect().height,
                                    balance:row.querySelector('summary > strong').textContent,
                                    balanceRight:row.querySelector('summary > strong').getBoundingClientRect().right,
                                    warnings:[...row.querySelectorAll('li[data-low="true"]')].map(li=>({
                                        label:li.firstElementChild.textContent,
                                        value:li.querySelector('strong').textContent,
                                        height:li.getBoundingClientRect().height,
                                        valueRight:li.querySelector('strong').getBoundingClientRect().right
                                    }))
                                }))
                            })"""))
                        if args.assert_compact:
                            results[name]['compactInteractions']=[]
                            for provider_index, section in enumerate(await page.locator('article section[class*="__accounts___"]').all()):
                                closed=section.locator('details:not([open])')
                                for row in await closed.all():
                                    assert await row.locator('ul[aria-label="Limits"] li').evaluate_all("nodes=>nodes.every(n=>n.checkVisibility()===(n.dataset.low==='true'))")
                                    status=row.locator('[class*="__accountStatus___"]')
                                    if await row.get_attribute('data-status') != 'ok': assert await status.is_visible()
                                if await closed.count():
                                    index=await closed.first.evaluate("el=>[...el.parentElement.children].indexOf(el)")
                                    row=section.locator('details').nth(index)
                                    summary=row.locator('summary')
                                    await summary.focus(); await summary.press('Enter')
                                    assert await row.get_attribute('open') is not None
                                    assert await row.locator('ul[aria-label="Limits"]').is_visible()
                                    await summary.press('Enter')
                                    assert await row.get_attribute('open') is None
                                card=page.locator('article').nth(provider_index)
                                toggle=card.locator('button[class*="__graphToggle___"]')
                                await toggle.click()
                                for limits in await card.locator('details:not([open]) ul[aria-label="Limits"]').all():assert await limits.is_visible()
                                await toggle.click()
                                results[name]['compactInteractions'].append(dict(providerIndex=provider_index, result='warnings retained; keyboard expansion and full-card restore passed'))

                    print(name, "captured", flush=True)
                    saved.write_text(json.dumps(results, indent=2)+"\n")
                    await context.close()
                    continue
                # Exercise chart keyboard inspection after capturing the fixed
                # visual state, so screenshots stay comparable.
                interaction = {}
                if width >= 901:
                    # Table: every limit cell starts exactly under its column heading.
                    alignment = await page.locator('article section[class*="__accounts___"]').evaluate_all('''sections => sections.flatMap(section => {
                        const heads = [...section.querySelectorAll('[class*="__accountHead___"] > span')];
                        return [...section.querySelectorAll('details:not([open]) ul[aria-label="Limits"] li')].map(li => {
                            const col = Number(getComputedStyle(li).getPropertyValue('--col'));
                            return {offset: Math.abs(li.getBoundingClientRect().left - heads[col + 2].getBoundingClientRect().left)};
                        });
                    })''')
                    assert all(cell['offset'] < 1 for cell in alignment), f"Limits not under their headings: {alignment}"
                else:
                    # Stacked: label | bar | value rows; every value ends on the list's right edge.
                    alignment = await page.locator('article details:not([open]) ul[aria-label="Limits"]').evaluate_all('''lists => lists.flatMap(list => {
                        const edge = list.getBoundingClientRect().right;
                        return [...list.children].filter(li => li.checkVisibility()).map(li => {
                            const label = li.querySelector(':scope > span').getBoundingClientRect();
                            const value = li.querySelector(':scope > strong').getBoundingClientRect();
                            return {rightOffset:Math.abs(edge-value.right), lineOffset:Math.abs(label.top-value.top)};
                        });
                    })''')
                    assert all(cell['rightOffset'] < 1 and cell['lineOffset'] < 12 for cell in alignment), f"Misaligned collapsed limits: {alignment}"
                interaction["collapsed_labels_and_values_align"] = "passed"
                if state == "refresh-pending":
                    countdown = page.locator('[class*="__countdown___"]')
                    await countdown.filter(has_text="Auto-refresh in").wait_for(timeout=9000)
                    elapsed = time.monotonic() - refresh_started
                    assert collection_requests == 1, "Completion reads must not start another collection"
                    interaction["refresh_completion_seconds"] = round(elapsed, 2)
                if state == "ready":
                    combined = page.get_by_role("region", name="Combined usage", exact=True)
                    assert await combined.locator("svg [data-series]").count() == 2
                    assert await combined.evaluate("e=>e.getBoundingClientRect().top < document.querySelector('article').getBoundingClientRect().top")
                    plots = page.locator('[class*="__forecast___"]')
                    assert await plots.count() == 3
                    for plot in await plots.all():
                        svg = plot.locator('svg[role="img"]')
                        before_height = (await svg.bounding_box())["height"]
                        button = page.locator(f'button[aria-controls="{await plot.get_attribute("id")}"]')
                        await button.click()
                        assert await button.get_attribute("aria-pressed") == "true"
                        assert (await svg.bounding_box())["height"] < before_height - 50
                        assert await svg.locator('text').count() > 0
                    await page.screenshot(path=str(out / f"{name}-minimized.png"), full_page=True, animations="disabled")
                    for plot in await plots.all():
                        await page.locator(f'button[aria-controls="{await plot.get_attribute("id")}"]').click()
                    assert await page.locator('article details').count() == 5
                    interaction["combined_top_and_all_graphs_minimize"] = "passed"
                    corner = page.locator('article [class*="__reorder___"]').first
                    geometry = await corner.locator('button').evaluate_all("nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,text:n.textContent}})")
                    assert len(geometry)==3 and all(abs(c['y']-geometry[0]['y'])<1 for c in geometry)
                    assert geometry[0]['text']==''
                    if width>900: assert all(c['w']<=28 and c['h']<=28 for c in geometry)
                    interaction["subtle_icons_aligned_beside_reorder"] = "passed"
                    view = page.get_by_role('combobox',name='Chart view',exact=True)
                    await view.select_option('stacked')
                    assert await combined.locator('svg [data-stack-band="recorded"]').count()==2
                    assert await combined.locator('svg [data-stack-band="projected"]').count()==2
                    assert await combined.locator('svg [data-series="total"]').count()==0
                    await view.select_option('providers')
                    assert await combined.locator('svg [data-series]').count()==2
                    interaction["provider_and_stacked_views"] = "passed"
                    if name == "wide":
                        filters = page.locator('[class*="__providerBar___"] button')
                        await filters.nth(1).click()
                        assert await combined.locator('svg [data-series]').count() == 1
                        assert await page.locator('article').count() == 1
                        await filters.nth(0).click()
                        assert await combined.locator('svg [data-series]').count() == 2
                        interaction["combined_respects_provider_filter"] = "passed"
                    countdown = page.locator('[class*="__countdown___"]')
                    before = await countdown.inner_text()
                    await page.wait_for_function(
                        "before => document.querySelector('[class*=\"__countdown___\"]').textContent !== before",
                        arg=before,
                    )
                    assert "Auto-refresh in" in await countdown.inner_text()
                    assert await page.get_by_role("button", name="Refresh all", exact=True).count() == 0
                    assert await page.locator('.header-actions button').first.is_visible()
                    overlaps = await countdown.evaluate('''node => {
                        const a = node.getBoundingClientRect();
                        const b = document.querySelector('.header-actions').getBoundingClientRect();
                        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
                    }''')
                    assert not overlaps, "Header controls must not cover countdown"
                    interaction["visible_countdown_ticks_without_duplicate_refresh"] = "passed"
                chart = page.locator('article svg[tabindex="0"]').first
                if await chart.count():
                    readout = page.locator(f'[id="{await chart.get_attribute("aria-describedby")}"]')
                    before = await readout.inner_text()
                    await chart.focus()
                    # The chart starts on the newest recorded sample; step whichever way has room.
                    away, back = "ArrowLeft", "ArrowRight"
                    await chart.press(away)
                    if await readout.inner_text() == before:
                        away, back = back, away
                        await chart.press(away)
                    assert await readout.inner_text() != before, "Arrow keys must change the sample"
                    await chart.press(back)
                    assert await readout.inner_text() == before
                    interaction["keyboard_sample_readout"] = "passed"
                if name == "wide":
                    titles = lambda: page.locator("article h2").all_inner_texts()
                    first = (await titles())[0]
                    await page.get_by_role("button", name=f"Move {first.split(' ')[0]} down").click()
                    moved = await titles()
                    assert moved[1] == first and moved[0] != first, "Move down must swap the first two pools"
                    stored_order = await page.evaluate("localStorage.getItem('prox-pool-order')")
                    assert stored_order and "codex" in stored_order.split("claude")[0], "The new order must be saved"
                    await page.get_by_role("button", name=f"Move {first.split(' ')[0]} up").click()
                    assert (await titles())[0] == first
                    interaction["pool_reorder_persists"] = "passed"
                if state == "expanded":
                    first = page.locator("article").first
                    assert await first.locator("details[open]").count() == await first.locator("details").count()
                    await first.get_by_role("button", name="Collapse all").click()
                    assert await first.locator("details[open]").count() == 0
                    interaction["expand_all_toggles_every_account"] = "passed"
                if state == "collecting":
                    assert await page.locator('article svg[tabindex="0"]').count() == 0
                    interaction["single_sample_is_not_focusable"] = "passed"
                if state in ("empty", "loading", "error"):
                    assert await page.locator('fieldset, [class*="__providerBar___"], [class*="__privacy___"]').count() == 0
                    interaction["no_chart_controls_without_data"] = "passed"
                if state == "empty":
                    assert await page.get_by_role("link", name="Add credentials", exact=True).get_attribute("href") == "#/oauth"
                    interaction["credential_action_targets_login"] = "passed"
                if state == "ready":
                    interval = page.get_by_role("combobox", name="Rate interval", exact=True)
                    async with page.expect_request(
                        lambda request: "/prox/pools?" in request.url and "lookback=6" in request.url
                    ):
                        await interval.select_option("6")
                    assert await interval.input_value() == "6"
                    interaction["rate_interval_updates_request"] = "passed"
                results[name]["interaction"] = interaction
                saved.write_text(json.dumps(results, indent=2) + "\n")
                await context.close()
                print(name, "captured", flush=True)
        finally:
            await browser.close()
    (out / "measurements.json").write_text(json.dumps(results, indent=2) + "\n")
    summary = {}
    for name, result in results.items():
        scopes = [result, *result.get("accountMeasurements", [])]
        summary[name] = dict(
            pageOverflow=any(r["pageOverflow"] for r in scopes),
            **{key:sum(len(r.get(key, [])) for r in scopes)
               for key in ["clipped", "targetFailures", "contrastFailures", "semanticFailures", "guideFailures", "inkFailures", "nestingFailures", "hiddenReasonFailures"]},
            errors=result["errors"],
        )
    if args.compact_baseline:
        baseline = json.loads((ROOT / "docs/evidence/hillclimb" / args.compact_baseline / "measurements.json").read_text())
        for name, result in results.items():
            expected = baseline[name]["accountSections"]
            actual = result["accountSections"]
            assert len(actual) == len(expected), f"{name}: provider sections changed"
            for section, before in zip(actual, expected):
                assert section["height"] <= before["height"] + 0.5, f"{name}: account section grew"
                assert len(section["rows"]) == len(before["rows"]), f"{name}: account count changed"
                for row, old in zip(section["rows"], before["rows"]):
                    assert row["name"] == old["name"] and row["balance"] == old["balance"], f"{name}: identity or balance changed"
                    assert row["height"] <= old["height"] + 0.5, f"{name}: account row grew"
                    assert row["nameHeight"] <= old["nameHeight"] + 0.5, f"{name}: name gained a line"
                    assert len(row["warnings"]) == len(old["warnings"]), f"{name}: warnings changed"
                    for warning, prior in zip(row["warnings"], old["warnings"]):
                        assert warning["label"] == prior["label"] and warning["value"] == prior["value"], f"{name}: warning meaning changed"
                        assert warning["height"] <= prior["height"] + 0.5, f"{name}: warning gained a line"
                        assert abs(warning["valueRight"] - row["balanceRight"]) <= 0.5, f"{name}: warning no longer aligns with its account balance"
                result["compactBaseline"] = args.compact_baseline
        saved.write_text(json.dumps(results, indent=2) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    if args.assert_compact:
        assert all(not value for case in summary.values() for value in case.values()), "Rendered checks failed; inspect summary.json"



if __name__ == "__main__":
    asyncio.run(main())

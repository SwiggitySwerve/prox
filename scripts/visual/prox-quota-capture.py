"""Repeatable browser fixtures for Prox UI review; never reads real credentials."""

import argparse
import asyncio
import colorsys
import json
import math
from collections import Counter
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
NOW = 1793102400000
DAY = 86_400_000


def fixture(state):
    """Synthetic, precomputed API contract examples, not production forecasts."""
    pools = []
    for provider, count, remaining, burn in [
        ("claude", 3, 248.4, 3.7),
        ("codex", 2, 142.8, 2.7),
    ]:

        def point(at, value):
            return dict(
                atMs=at,
                remainingPoints=value,
                burnPointsPerHour=burn,
                drainPointsPerHour=burn,
            )

        recorded = [
            point(NOW - DAY * (3 - i / 8), remaining + (24 - i) * 1.3)
            for i in range(25)
        ]
        projected = [
            point(NOW, remaining),
            point(NOW + DAY, remaining - 75),
            point(NOW + DAY, remaining + 25),
            point(NOW + 4 * DAY, 30),
            point(NOW + 4 * DAY, 130),
            point(NOW + 7 * DAY, 10),
        ]
        accounts = [
            dict(
                id=f"{provider}-{i}",
                label=f"{provider.title()} account {i + 1}",
                disabled=False,
                status="ok",
                observedAtMs=NOW,
                remainingPercent=round(remaining / count, 1),
                resetAtMs=NOW + DAY * (i + 1),
                burnPointsPerHour=burn / count,
                emptyAtMs=NOW + DAY * (2 + i),
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
            nextResetGainPoints=100,
            recorded=recorded,
            projected=projected,
            resets=[
                dict(atMs=NOW + DAY, gainPoints=100),
                dict(atMs=NOW + 4 * DAY, gainPoints=100),
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
            )
            if state != "collecting":
                pool.update(remainingPoints=None, loadedCount=count - 1)
                accounts[-1].update(
                    status="stale" if state == "stale" else "error",
                    remainingPercent=None,
                )
            if state == "collecting":
                pool["recorded"] = [point(NOW, remaining)]
        if state == "long":
            accounts[0]["label"] = (
                "A deliberately long credential label for a shared development workstation"
            )
            accounts[1]["status"] = "missing-window"
            accounts[1]["remainingPercent"] = None
        pools.append(pool)
    return dict(
        nowMs=NOW,
        fromMs=NOW - 3 * DAY,
        toMs=NOW + 7 * DAY,
        window="weekly",
        lookbackHours=3,
        multiplier=1,
        historyStartedAtMs=NOW - 3 * DAY,
        lastRefreshAtMs=NOW,
        nextRefreshAtMs=NOW + 300000,
        refreshing=False,
        issues=[],
        pools=[] if state == "empty" else pools,
    )


GEOMETRY = r"""() => {
  const root=document.querySelector('[class*="QuotaPoolPage"][class*="__page___"]');
  const visible=e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden'&&e.checkVisibility({checkVisibilityCSS:true});};
  const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,w:b.width,h:b.height};};
  const controls=[...root.querySelectorAll('button,select,input,summary,a')].filter(visible).map(e=>{
    const target=e.matches('input[type=checkbox]') ? e.closest('label') : e;
    return {text:(e.getAttribute('aria-label')||e.textContent||e.getAttribute('type')||'').trim().slice(0,100),...rect(target),disabled:e.matches(':disabled')};});
  const clipped=[...root.querySelectorAll('*')].filter(e=>visible(e)&&e.clientWidth>2&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>({tag:e.tagName,class:e.className,client:e.clientWidth,scroll:e.scrollWidth}));
  const text=[...root.querySelectorAll('h1,h2,h3,p,dt,dd,button,a,summary,span,label,svg text')].filter(e=>visible(e)&&e.textContent.trim()&&(!e.children.length||e.matches('h1,h2,p,button'))).map(e=>{
    const s=getComputedStyle(e);return {text:e.textContent.trim().slice(0,90),...rect(e),size:parseFloat(s.fontSize),weight:parseInt(s.fontWeight)||400,disabled:e.matches(':disabled'),tag:e.tagName};});
  const charts=[...root.querySelectorAll('article')].filter(e=>e.querySelector('svg')&&visible(e.querySelector('svg'))).map(e=>{
    const svg=e.querySelector('svg'), matrix=svg.getScreenCTM();
    const screen=(x,y)=>{const p=new DOMPoint(x,y).matrixTransform(matrix);return {x:p.x+scrollX,y:p.y+scrollY};};
    const strokePoints=[...svg.querySelectorAll('path[stroke]')].flatMap(path=>Array.from({length:11},(_,i)=>{const p=path.getPointAtLength(path.getTotalLength()*i/10);return screen(p.x,p.y);}));
    for(const c of svg.querySelectorAll('circle')) strokePoints.push(screen(c.cx.baseVal.value,c.cy.baseVal.value));
    return {provider:e.querySelector('h2')?.textContent?.toLowerCase(),...rect(svg),strokePoints};
  });
  return {pageWidth:document.documentElement.clientWidth,pageScrollWidth:document.documentElement.scrollWidth,controls,clipped,text,charts};
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
    return dict(
        **geo,
        contrast=readings,
        semanticColors=semantic,
        semanticFailures=semantic_failures,
        hueSeparation=separation,
        targetMinimum=target,
        targetFailures=[
            c
            for c in geo["controls"]
            if not c["disabled"] and (c["w"] < target - 0.1 or c["h"] < target - 0.1)
        ],
        contrastFailures=[r for r in readings if r["contrast"] < r["required"]],
        pageOverflow=geo["pageScrollWidth"] > geo["pageWidth"],
    )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:15173")
    ap.add_argument("--cases", nargs="*")
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
        ("drain", "drain", 1440, 1000),
        ("burn-narrow", "burn", 390, 844),
        ("refresh-error", "refresh-error", 1440, 1000),
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

                async def route_api(route):
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
                        await route.fulfill(json=fixture(state))
                        return
                    if "/prox/refresh" in url:
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
                    const {useThemeStore}=await import('/src/stores/useThemeStore.ts');
                    const i18n=(await import('/src/i18n/index.ts')).default; await i18n.changeLanguage('en');
                    useThemeStore.getState().setTheme('dark');
                    apiClient.setConfig({apiBase:location.origin,managementKey:'visual-fixture-only'});
                    useAuthStore.setState({isAuthenticated:true,connectionStatus:'connected',apiBase:location.origin,managementKey:'visual-fixture-only'});
                    location.hash='/quota';
                }""")
                await page.locator(
                    '[class*="QuotaPoolPage"][class*="__page___"]'
                ).wait_for()
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
                if state in ("drain", "burn"):
                    await page.get_by_role(
                        "button",
                        name="Drain rate" if state == "drain" else "Burn rate",
                        exact=True,
                    ).click()
                if state == "details":
                    await (
                        page.locator('details[class*="__account___"]')
                        .first.locator("summary")
                        .click()
                    )
                if state == "refresh-error":
                    await page.locator('button[class*="__refresh___"]').click()
                    await page.locator('[role="alert"]').wait_for()
                # Baseline charts are disclosures; capture their expanded state too.
                if state in ("drain", "burn"):
                    await page.locator('details[class*="__forecast___"]').evaluate_all(
                        "(nodes)=>nodes.forEach(n=>n.open=true)"
                    )
                await page.evaluate("document.fonts.ready")
                await page.wait_for_timeout(350)
                path = out / f"{name}.png"
                await page.screenshot(
                    path=str(path), full_page=True, animations="disabled"
                )
                geo = await page.evaluate(GEOMETRY)
                results[name] = dict(
                    state=state,
                    viewport=[width, height],
                    errors=errors,
                    **measure(path, geo, width < 600),
                )
                saved.write_text(json.dumps(results, indent=2) + "\n")
                await context.close()
                print(name, "captured", flush=True)
        finally:
            await browser.close()
    (out / "measurements.json").write_text(json.dumps(results, indent=2) + "\n")
    summary = {
        name: dict(
            pageOverflow=r["pageOverflow"],
            clipped=len(r["clipped"]),
            targetFailures=len(r["targetFailures"]),
            contrastFailures=len(r["contrastFailures"]),
            semanticFailures=len(r["semanticFailures"]),
            errors=r["errors"],
        )
        for name, r in results.items()
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    asyncio.run(main())

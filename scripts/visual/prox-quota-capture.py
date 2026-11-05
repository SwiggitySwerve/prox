"""Repeatable browser fixtures for Prox UI review; never reads real credentials."""

import argparse
import asyncio
import colorsys
import io
import json
import hashlib
import io
import math
import re
import time
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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
                id=f"external:{provider}:" + hashlib.sha256(f"{provider}\0fixture-{provider}-{i}".encode()).hexdigest(),
                sourceAccountId=f"external:{provider}:" + hashlib.sha256(f"{provider}\0fixture-{provider}-{i}".encode()).hexdigest(),
                billing=(dict(provider="claude", status="active", activeSinceMs=NOW-45*DAY, billingType="stripe_subscription") if provider == "claude" else
                    dict(provider="codex", plan="pro", renewsAtMs=NOW+17*DAY if i==0 else None, endsAtMs=None if i==0 else NOW+8*DAY, willRenew=i==0,
                         nextPlan=dict(plan="prolite", atMs=NOW+17*DAY) if i==0 else None, overdue=False, graceEndsAtMs=None)),
                resets=(dict(available=2 if provider == "codex" else 1, usable=2 if provider == "codex" else 0, blocker=None if provider == "codex" else "not_limited", nextExpiryAtMs=NOW + 7 * DAY, observedAtMs=NOW) if i == 0 else None),
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
            instanceId="external",
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
        if state == "long-name":
            # A name beyond 28ch, beside a (usable) reset chip: the minimized list truncates it with a title.
            accounts[0]["identifier"] = "a.deliberately.long.credential.name.for.a.shared.workstation@example-corporate.test"
        pools.append(pool)
    if state == "multi-low":
        # One Claude row with several low limits beside a normal weekly value (5-hour and Weekly Opus),
        # and one whose own weekly value is low as well.
        first, third = pools[0]["accounts"][0], pools[0]["accounts"][2]
        first["windows"] = [dict(w, remainingPercent={"five-hour": 9, "seven-day-opus": 12}.get(w["id"], w["remainingPercent"])) for w in first["windows"]]
        third.update(remainingPercent=11)
        third["windows"] = [dict(w, remainingPercent=11) if w["id"] == "seven-day" else w for w in third["windows"]]
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
                            nextResetGainPoints=round(pools[0]["nextResetGainPoints"] * f),
                            resets=[dict(r, gainPoints=round(r["gainPoints"] * f)) for r in pools[0]["resets"]])
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
        total["projected"] = [dict(item, remainingPoints=item["remainingPoints"] * 1964.4 / 391.2)
                              for item in total["projected"]]
    if state == "no-limit":
        total.update(capacityPoints=400, remainingPoints=152)
        # The total is the sum of the provider layers at the same moments, so the bands stack.
        total["projected"] = [dict(a, remainingPoints=a["remainingPoints"] + b["remainingPoints"])
                              for a, b in zip(pools[0]["projected"], pools[1]["projected"])]
    if state in ("partial","stale","collecting","long"):
        total.update(forecastState="partial" if state=="long" else state, projected=[],resets=[])
        if state!="collecting": total.update(remainingPoints=None,burnPointsPerHour=None,drainPointsPerHour=None)
    # Each layer is its pool's own history and the total is their sum at the same moments, so the
    # combined chart covers the same span as the provider charts (a missing value stays missing).
    layers=[]
    for pool in pools:
        layer={key:pool[key] for key in total}
        layer["provider"]=pool["provider"]
        layer["instanceId"]=pool["instanceId"]
        layer["recorded"]=[dict(item) for item in pool["recorded"]]
        layers.append(layer)
    if len(layers) == 2:
        fields = ("remainingPoints", "burnPointsPerHour", "drainPointsPerHour")
        total["recorded"] = [
            dict(atMs=a["atMs"], **{key: None if a[key] is None or b[key] is None else a[key] + b[key] for key in fields})
            for a, b in zip(layers[0]["recorded"], layers[1]["recorded"])
        ]
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
  const clipped=[...root.querySelectorAll('*')].filter(e=>visible(e)&&e.clientWidth>2&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible'&&!(getComputedStyle(e).textOverflow==='ellipsis'&&e.title)).map(e=>({tag:e.tagName,class:e.className,client:e.clientWidth,scroll:e.scrollWidth}));
  // Visible interactive elements whose boxes intersect by more than 2px in both axes (nested pairs excepted).
  const interactive=[...root.querySelectorAll('button,a[href],select,input,summary,[role=button],[role=tab]')].filter(visible);
  const overlaps=[];
  for(let i=0;i<interactive.length;i++)for(let j=i+1;j<interactive.length;j++){
    const a=interactive[i],b=interactive[j];
    if(a.contains(b)||b.contains(a))continue;
    const p=a.getBoundingClientRect(),q=b.getBoundingClientRect();
    const dx=Math.min(p.right,q.right)-Math.max(p.left,q.left),dy=Math.min(p.bottom,q.bottom)-Math.max(p.top,q.top);
    if(dx>2&&dy>2){const name=e=>(e.getAttribute('aria-label')||e.textContent||e.tagName).trim().slice(0,40);overlaps.push({a:name(a),b:name(b),dx:Math.round(dx),dy:Math.round(dy)});}
  }
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
  return {marks,pageWidth:providedRoot?root.clientWidth:document.documentElement.clientWidth,pageScrollWidth:providedRoot?root.scrollWidth:document.documentElement.scrollWidth,controls,clipped,overlaps,text,charts,guides};
}"""


# Shared by the C3 checks: colours, effective opacity and the rows that count as low or stale.
C3_HELPERS = r"""
const rgb=c=>{const n=c.match(/[\d.]+/g).slice(0,3).map(Number);return c.startsWith('color(')?n.map(v=>Math.round(v*255)):n;};
const isRed=c=>{const [r,g,b]=rgb(c).map(v=>v/255),mx=Math.max(r,g,b),mn=Math.min(r,g,b);if(mx-mn<0.3||mx<0.5)return false;
  const h=mx===r?(60*((g-b)/(mx-mn))+360)%360:mx===g?60*((b-r)/(mx-mn))+120:60*((r-g)/(mx-mn))+240;return h>=345||h<=15;};
const opacity=e=>{let o=1;for(let n=e;n&&n.nodeType===1;n=n.parentElement)o*=parseFloat(getComputedStyle(n).opacity);return o;};
const shown=e=>e.checkVisibility({checkVisibilityCSS:true});
const textNodeWith=(root,re)=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(w.nextNode())if(re.test(w.currentNode.textContent))return w.currentNode;return null;};
const textRight=node=>{const r=document.createRange();r.selectNodeContents(node);return Math.max(...[...r.getClientRects()].map(b=>b.right));};
"""
# The fixtures that carry no account rows have nothing for the account checks to measure.
C3_NO_ROSTER = ("empty", "loading", "error")
# Cases captured with every card minimized, so the wide minimized list is measured.
MINIMIZED_CASES = (
    "stale-minimized", "many-low-minimized", "multi-low-minimized",
    "stale-minimized-1920", "many-low-minimized-1920", "multi-low-minimized-1920",
    "wide-minimized-1100", "wide-minimized-1280", "wide-minimized-1440", "wide-minimized-1920",
    "long-minimized-901",
)
# Extra pages (fixture state, width, language) the minimized check also runs on, opened fresh.
MINIMIZED_SWEEPS = {"wide-minimized-1440": [("multi-low", 1440, lng) for lng in ("ru", "vi")]}


async def low_colour_failures(page, state):
    """I1: a low value keeps the normal value colour; its own red icon and visible "Low" carry it."""
    if state in C3_NO_ROSTER:
        return []
    found = await page.evaluate("() => {" + C3_HELPERS + r"""
      const out=[],values=[...document.querySelectorAll('article details > summary > strong[data-low="true"], article ul[aria-label="Limits"] li[data-low="true"] > strong')].filter(shown);
      if(!values.length)out.push({why:'no visible low value in a case that has a roster'});
      for(const e of values){
        const where=(e.closest('details').querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent||'')+' '+(e.parentElement.tagName==='LI'?e.parentElement.firstElementChild.textContent:'row value');
        const pct=textNodeWith(e,/%/),icons=[...e.querySelectorAll('[class*="__limitWarning___"]')].filter(shown),words=[...e.querySelectorAll('[class*="__lowWord___"]')].filter(shown);
        if(!pct)out.push({where,why:'no percentage text'});
        else if(isRed(getComputedStyle(pct.parentElement).color))out.push({where,why:'percentage is in the critical red'});
        if(icons.length!==1||!isRed(getComputedStyle(icons[0]).color)||icons[0].getAttribute('aria-hidden')!=='true')out.push({where,why:'needs exactly one aria-hidden red icon',icons:icons.length});
        if(words.length!==1||words[0].textContent.trim()!=='Low')out.push({where,why:'needs exactly one visible "Low"',words:words.length});
        else if(isRed(getComputedStyle(words[0]).color)||getComputedStyle(words[0]).fontWeight!=='600')out.push({where,why:'"Low" must be neutral and weight 600'});
        if(e.querySelector('[class*="__srOnly___"]')||(e.textContent.match(/Low/g)||[]).length!==1)out.push({where,why:'"Low" is announced more than once'});
        const bar=e.parentElement.querySelector('[class*="__limitBar___"] > span');
        if(bar&&shown(bar)&&!isRed(getComputedStyle(bar).backgroundColor))out.push({where,why:'low bar fill is not red'});
      }
      return out;
    }""")
    return found


async def stale_dim_failures(page, state):
    """I2: stale values and bars match current rows in colour and effective opacity."""
    if state != "stale":
        return []
    return await page.evaluate("() => {" + C3_HELPERS + r"""
      const out=[],seen=(row)=>[...row.querySelectorAll(':scope > summary > strong, :scope ul[aria-label="Limits"] li > strong')].filter(shown).map(e=>({kind:'value',e}))
        .concat([...row.querySelectorAll('[class*="__limitBar___"] > span')].filter(shown).map(e=>({kind:'bar'+(e.closest('li').dataset.low==='true'?'-low':''),e})));
      for(const article of document.querySelectorAll('article')){
        const rows=[...article.querySelectorAll('details[data-status]')],stale=rows.filter(r=>r.dataset.status==='stale'),current=rows.filter(r=>r.dataset.status==='ok');
        const colour=(x)=>getComputedStyle(x.e)[x.kind==='value'?'color':'backgroundColor'];
        const ref={};for(const r of current)for(const x of seen(r))(ref[x.kind]??=new Set()).add(colour(x));
        for(const r of stale)for(const x of seen(r)){
          const name=r.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent+' '+x.kind;
          if(Math.abs(opacity(x.e)-1)>0.001)out.push({where:name,why:'effective opacity is '+opacity(x.e)});
          if(ref[x.kind]&&!ref[x.kind].has(colour(x)))out.push({where:name,why:'colour '+colour(x)+' differs from current rows '+[...ref[x.kind]]});
        }
        if(article.querySelector('h2')&&!stale.length&&/claude/i.test(article.querySelector('h2').textContent))out.push({why:'no stale row to measure in the Claude card'});
      }
      return out;
    }""")


async def stale_label_failures(page, state):
    """I3: every stale row shows the amber "Stale" word, a clock icon and its timestamp, inside its row."""
    if state != "stale":
        return []
    return await page.evaluate(STALE_JS, "en")


# Phones and longer languages wrap the timestamp; it must still stay inside its row (390 English alone hid this).
STALE_SWEEP = ((320, "en"), (390, "ru"), (390, "vi"))


async def stale_sweep_failures(browser, url, name):
    """I3 again at 320px and in ru and vi, on pages of their own (run once, from the stale-narrow case)."""
    if name != "stale-narrow":
        return []
    out = []
    for width, lng in STALE_SWEEP:
        context, sweep = await open_fixture_page(browser, url, "stale", width, lng, None)
        try:
            out += [dict(f, width=width, lng=lng) for f in await sweep.evaluate(STALE_JS, lng)]
        finally:
            await context.close()
    return out


STALE_JS = "(lng) => {" + C3_HELPERS + r"""
      const out=[],rows=[...document.querySelectorAll('article details[data-status="stale"]')];
      if(!rows.length)out.push({why:'no stale row'});
      for(const row of rows){
        const where=row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent,status=row.querySelector('[class*="__accountStatus___"]');
        if(!status||!shown(status)){out.push({where,why:'status line is not visible'});continue;}
        const icon=status.querySelector('svg'),size=parseFloat(getComputedStyle(status).fontSize),box=status.getBoundingClientRect(),summary=row.querySelector('summary').getBoundingClientRect();
        if(lng==='en'&&!/^Stale\b/.test(status.textContent.trim()))out.push({where,why:'status does not start with "Stale"'});
        if(!icon||icon.getAttribute('aria-hidden')!=='true'||!shown(icon)||!icon.matches('[class*="__staleIcon___"]'))out.push({where,why:'no visible aria-hidden clock icon'});
        if(!/\d{1,2}:\d{2}/.test(status.textContent))out.push({where,why:'no timestamp'});
        const word=status.querySelector('[class*="__staleWord___"]');
        if(!word)out.push({where,why:'no stale word group'});
        else if(icon&&Math.abs(icon.getBoundingClientRect().top-word.getBoundingClientRect().top)>size)out.push({where,why:'the clock and "Stale" are on different lines'});
        if(status.scrollWidth>status.clientWidth+1||textRight(status)>summary.right+1)out.push({where,why:'status overflows its row'});
      }
      return out;
    }"""


A_PAGED_CASES = ("many", "many-low", "many-narrow")  # rosters that offer Show more
CAVEAT_EN = "Renewal dates are estimated from each plan's start date; annual plans differ."
# Reads every Accounts section: the caveat's place, count and text. Returns {out, texts} for one page state.
CAVEAT_JS = "() => {" + C3_HELPERS + r"""
  const out=[],texts=[],caveat='[class*="__renewalCaveat___"]';
  for(const article of document.querySelectorAll('article')){
    const section=article.querySelector('section[class*="__accounts___"]'),card=article.querySelector('h2').textContent;
    // Fixture: every Claude account's renewal is estimated from its start date; Codex reports its dates.
    const want=/claude/i.test(card)?1:0,got=[...section.querySelectorAll(caveat)];
    if(got.length!==want)out.push({card,why:'expected '+want+' caveat(s), found '+got.length});
    const grid=section.querySelector('[class*="__accountGrid___"]'),footer=section.querySelector('[class*="__rosterFooter___"]');
    for(const c of got){
      texts.push({card,text:c.textContent.trim()});
      if(!shown(c))out.push({card,why:'caveat is not visible'});
      if(c.parentElement!==section||c.closest('details'))out.push({card,why:'caveat sits inside a row, a disclosure or the paged list'});
      const after=[grid,footer].filter(Boolean);
      const bottom=Math.max(...after.map(e=>e.getBoundingClientRect().bottom));
      if(c.getBoundingClientRect().top<bottom-0.5)out.push({card,why:'caveat top '+Math.round(c.getBoundingClientRect().top)+' is above the list/footer bottom '+Math.round(bottom)});
      if(after.some(e=>!(e.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING)))out.push({card,why:'caveat precedes the list or footer in the DOM'});
      if(section.lastElementChild!==c)out.push({card,why:'caveat is not the last item of the section'});
    }
    const mentions=(section.innerText.match(/annual plans differ|годовые тарифы|gói năm/gi)||[]).length;
    if(mentions!==want)out.push({card,why:'the annual-plan sentence appears '+mentions+' times, expected '+want});
  }
  if([...document.querySelectorAll(caveat)].some(c=>!c.closest('section[class*="__accounts___"]')))out.push({why:'caveat outside an Accounts section'});
  return {out,texts};
}"""


async def caveat_pass(page, label, out, ref, lng="en"):
    """Measure the caveat in the page's current state; every state must show the same text as the first one read."""
    got = await page.evaluate(CAVEAT_JS)
    out += [dict(f, during=label, lng=lng) for f in got["out"]]
    if not got["texts"]:
        out.append(dict(why="no caveat to measure", during=label, lng=lng))
    for t in got["texts"]:
        ref.setdefault(t["card"], t["text"])
        if t["text"] != ref[t["card"]]:
            out.append(dict(card=t["card"], why=f"caveat text changed to {t['text']!r}", during=label, lng=lng))
        if lng == "en" and t["text"] != CAVEAT_EN:
            out.append(dict(card=t["card"], why=f"caveat reads {t['text']!r}", during=label, lng=lng))
        if lng != "en" and t["text"] == CAVEAT_EN:
            out.append(dict(card=t["card"], why="caveat is not translated", during=label, lng=lng))


async def renewal_caveat_failures(page, context, url, route_api, name, state):
    """A2: each provider Accounts section with an estimated renewal among any of its accounts shows the caveat exactly
    once, after the list and its Show more footer (never inside a row, disclosure or page), with the same text when
    rows are closed, opened, searched, filtered or paged, in DOM and visual order. Short basis stays on one line."""
    if state in C3_NO_ROSTER:
        return []
    out, ref = [], {}
    await caveat_pass(page, "closed", out, ref)
    toggles = page.locator('article [class*="__expandAccounts___"][aria-expanded="false"]:not([class*="__showAll___"])')
    closed = await toggles.count()  # the cases that start expanded have none to open
    for _ in range(closed):
        await toggles.first.click()
    await caveat_pass(page, "opened", out, ref)
    for _ in range(closed):
        await page.locator('article [class*="__expandAccounts___"][aria-expanded="true"]:not([class*="__showAll___"])').first.click()
    search = page.get_by_role("searchbox", name="Search accounts").first
    if await search.count():
        original = await search.input_value()
        for term in ("zzzz-no-match", "gra"):
            await search.fill(term)
            await caveat_pass(page, f"searched {term!r}", out, ref)
        await search.fill(original)
    low = page.locator('article [class*="__rosterLow___"]')
    if await low.count():
        flip = await low.first.get_attribute("aria-pressed") != "true"  # many-low starts filtered
        if flip:
            await low.first.click()
        await caveat_pass(page, "filtered", out, ref)
        if flip:
            await low.first.click()
    if state == "expanded":
        out += await page.evaluate("() => {" + C3_HELPERS + r"""
          const out=[],basis=[...document.querySelectorAll('[class*="__detail___"]')].filter(e=>/^Estimated/.test(e.textContent.trim()));
          if(!basis.length)out.push({why:'no displayed estimated renewal to measure'});
          for(const e of basis){const fs=parseFloat(getComputedStyle(e).fontSize);
            if(e.textContent.trim()!=='Estimated · from start date')out.push({why:'basis reads "'+e.textContent.trim()+'"'});
            if(e.getBoundingClientRect().height>fs*1.8||e.scrollWidth>e.clientWidth+1)out.push({why:'basis wraps or is clipped'});}
          return out;
        }""")
    if name in A_PAGED_CASES:
        # A fresh page for what can't be undone (Show more).
        fresh = await r_page(context, url, route_api, state, "en")
        try:
            more = fresh.locator('article [class*="__rosterFooter___"] button')
            if await more.count():
                await more.first.click()
                await caveat_pass(fresh, "paged", out, dict(ref))
            else:
                out.append(dict(why="no Show more to page with", during="paged"))
        finally:
            await fresh.close()
    if name in R_LANG_CASES:
        for lng in R_LANGS:
            fresh = await r_page(context, url, route_api, state, lng)
            try:
                await caveat_pass(fresh, "closed", out, {}, lng)
            finally:
                await fresh.close()
    return out


MINIMIZED_PROXIMITY_JS = "() => {" + C3_HELPERS + r"""
      const out=[],cards=[...document.querySelectorAll('article')].filter(a=>a.querySelector('section[class*="__accounts___"] details'));
      if(!cards.length)out.push({why:'no card with account rows'});
      const same=(xs,tol=1)=>xs.length<2||Math.max(...xs)-Math.min(...xs)<=tol;
      const R=e=>e.getBoundingClientRect(),over=(a,b)=>a.left<b.right-0.5&&a.right>b.left+0.5&&a.top<b.bottom-0.5&&a.bottom>b.top+0.5;
      const cols=[];let allHeights=[],lowSeen=0;
      for(const a of cards){
        const card=a.querySelector('h2').textContent,cs=getComputedStyle(a),box=R(a),
          contentW=box.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-parseFloat(cs.borderLeftWidth)-parseFloat(cs.borderRightWidth),
          head=[...a.querySelectorAll('[class*="__compactHead___"] > span')].filter(shown),
          rows=[...a.querySelectorAll('details:not([open])')].filter(shown);
        if(head.length!==3||!rows.length){out.push({card,why:'missing header or rows'});continue;}
        const hb=head.map(R);
        cols.push({card,left:hb[0].left,w0:hb[0].width,w1:hb[1].width,right1:hb[1].right});
        for(const h of head)if(h.scrollWidth>h.clientWidth+1||R(h).height>20)out.push({card,why:'column header wraps or is clipped: '+h.textContent});
        const probe=document.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;width:1ch';rows[0].querySelector('summary').appendChild(probe);
        const ch=R(probe).width;probe.remove();
        const heights=[],rights=[],valueLefts=[];
        for(const r of rows){
          const s=r.querySelector('summary'),nameCell=s.querySelector(':scope > [class*="__accountName___"]'),text=nameCell.querySelector('[class*="__accountText___"]'),
            chip=nameCell.querySelector('[class*="__accountResetMarker___"]'),strong=s.querySelector(':scope > strong'),limits=s.querySelector(':scope > ul'),
            label=text.textContent.trim(),rr=R(r),nb=R(nameCell);
          // Equal heights: a row with no status line and its low limits on one line.
          const lows=[...s.querySelectorAll(':scope > ul > li[data-low="true"]')].filter(li=>li.dataset.counted!=='true'),shownLows=lows.filter(shown);
          const oneLine=shownLows.every(li=>Math.abs(R(li).top-R(shownLows[0]).top)<4&&R(li).height<26);
          if(!shown(s.querySelector('[class*="__accountStatus___"]'))&&oneLine)heights.push(rr.height);
          // Account track: at most 40ch, left of the value track; items stay inside it.
          if(nb.width>40*ch+1)out.push({card,label,why:'Account track is '+(nb.width/ch).toFixed(1)+'ch wide'});
          if(Math.abs(nb.left-hb[0].left)>1)out.push({card,label,why:'Account cell not under its header'});
          if(Math.abs(R(strong).right-hb[1].right)>1)out.push({card,label,why:'value edge differs from its header'});
          if(limits&&shown(limits)&&Math.abs(R(limits).left-hb[2].left)>1)out.push({card,label,why:'other-low cell not under its header'});
          // Text lost: the name may end in an ellipsis only with its full text in a title.
          if(text.scrollWidth>text.clientWidth+1&&text.title!==label)out.push({card,label,why:'name truncated without a title'});
          if(text.scrollWidth<=text.clientWidth+1&&text.title)out.push({card,label,why:'title on a name that is not truncated'});
          if(R(text).width>28*ch+1)out.push({card,label,why:'name wider than 28ch'});
          // The chip stays on the name's line, whole.
          const items=[text,chip].filter(Boolean);
          if(chip){const c=R(chip),t=R(text);if(c.top>t.bottom-2||c.height>26||chip.scrollWidth>chip.clientWidth+1)out.push({card,label,why:'reset chip wraps below the name or is clipped'});}
          // Proximity (per column): the rightmost Account-cell item to the leftmost value, within the card.
          const right=Math.max(...items.map(e=>R(e).right));rights.push(right);valueLefts.push(R(strong).left);
          if(hb[1].left-right<0)out.push({card,label,why:'Account item overlaps the value column'});
          // Nothing overlaps; the value and every low limit are whole.
          const parts=[...items,strong,...shownLows].map(R);
          for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++)if(over(parts[i],parts[j]))out.push({card,label,why:'row items overlap'});
          if(strong.scrollWidth>strong.clientWidth+1||R(strong).height>24)out.push({card,label,why:'value wraps or is clipped'});
          if(!/\d/.test(strong.textContent)&&!strong.textContent.trim())out.push({card,label,why:'value is empty'});
          lowSeen+=shownLows.length;
          if(lows.length!==shownLows.length)out.push({card,label,why:'a low limit is hidden'});
          for(const li of shownLows){
            if(!li.firstElementChild.textContent.trim()||!/%/.test(li.querySelector('strong').textContent)||!li.querySelector('[class*="__limitWarning___"] svg')||!li.querySelector('[class*="__lowWord___"]'))out.push({card,label,why:'low limit lacks label, value, icon or Low word'});
            const sb=R(li.querySelector('strong'));if(sb.height>24||li.querySelector('strong').scrollWidth>li.querySelector('strong').clientWidth+1)out.push({card,label,why:'low limit value wraps or is clipped'});
          }
          const lb=limits&&shown(limits)?R(limits):null;
          if(lb&&lb.right>R(s).right+1)out.push({card,label,why:'other low limits overflow the row'});
        }
        const proximity=Math.min(...valueLefts)-Math.max(...rights);
        if(proximity>160)out.push({card,why:'rightmost Account item to the leftmost value is '+proximity.toFixed(0)+'px'});
        if(!same(heights))out.push({card,why:'closed rows differ in height: '+[...new Set(heights.map(h=>h.toFixed(1)))].join(',')});
        allHeights=allHeights.concat(heights);
        // Opening a row restores every limit and fact, across the card's content width.
        const row=rows[0],before=row.querySelectorAll(':scope > summary > ul > li').length;row.open=true;
        const grid=R(row.parentElement),opened=R(row),section=a.querySelector('section[class*="__accounts___"]'),ss=getComputedStyle(section),
          inner=contentW-parseFloat(ss.paddingLeft)-parseFloat(ss.paddingRight);
        if(Math.abs(opened.width-grid.width)>1||Math.abs(opened.width-inner)>1)out.push({card,why:'opened row is '+opened.width.toFixed(1)+'px, card content is '+inner.toFixed(1)});
        const limits=[...row.querySelectorAll(':scope > summary > ul > li')];
        if(!limits.every(shown)||limits.length!==before||!shown(row.querySelector('[class*="__accountFacts___"]')))out.push({card,why:'open row did not restore its limits and facts'});
        row.open=false;
      }
      if(cards.length&&!lowSeen)out.push({why:'no low limit to measure'});
      if(!same(allHeights))out.push({why:'equal-height rows differ across cards'});
      // Every provider card shares the same column tracks.
      if(cols.length<2)out.push({why:'fewer than 2 minimized cards to compare'});
      for(const k of ['left','w0','w1','right1'])if(!same(cols.map(c=>c[k])))out.push({why:'column '+k+' differs across cards: '+cols.map(c=>c[k].toFixed(1)).join(' / ')});
      return out;
    }"""


async def minimized_width_failures(page, name):
    """I5/C: minimized closed rows are left-aligned and content-sized on tracks shared by every row and card (<=160px from Account to value)."""
    if name not in MINIMIZED_CASES:
        return []
    return await page.evaluate(MINIMIZED_PROXIMITY_JS)


async def minimized_sweep_failures(browser, url, name):
    """The same check on fresh pages in other languages: every card minimized first."""
    out = []
    for state, width, lng in MINIMIZED_SWEEPS.get(name, ()):
        context, page = await open_fixture_page(browser, url, state, width, lng, None)
        try:
            for button in await page.locator('button[class*="__graphToggle___"]').all():
                await button.click()
            await page.wait_for_timeout(250)
            out += [dict(page=f"{state}@{width}/{lng}", **f) for f in await page.evaluate(MINIMIZED_PROXIMITY_JS)]
        finally:
            await context.close()
    return out


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
            # A fill under 8px wide (a low value's bar in a tight table cell) is mostly anti-aliased edge, so its
            # ink is the pixel at its centre rather than the most common colour in a box that includes the track.
            if mk["w"] < 8:
                dominant = im.getpixel((min(im.width - 1, round(mk["x"] + mk["w"] / 2)), round(mk["y"] + mk["h"] / 2)))
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
        overlapFailures=geo["overlaps"],
    )


# C1 card-header checks. Each has its own JSON key; every key is registered in C1_KEYS, which feeds the summary
# and so the --assert-compact gate. A check that finds nothing to measure where it applies fails.
C1_KEYS = ("factWrapFailures", "headerActionLabelFailures", "toggleConsistencyFailures",
           "phoneHeaderFailures", "actionNameFailures", "headerOrderFailures")
C1_FACT_WIDTHS = (390, 820, 1100, 1280, 1440, 1920)
C1_CARDLESS = ("empty", "loading", "error")
C1_PRELUDE = r"""
const shown = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.checkVisibility({checkVisibilityCSS: true}); };
const cards = () => [...document.querySelectorAll('article, section[class*="__combined___"]')];
const actions = card => [...card.querySelectorAll('[class*="__reorder___"] button')].filter(shown);
const box = e => { const b = e.getBoundingClientRect(); return {x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height)}; };
const name = e => (e.getAttribute('aria-label') || '').trim();
"""


async def check_fact_wrap(page, state, width):
    """I1: at 390/820/1100/1280/1440/1920 no Now/Forecast fact label, value or caption wraps, clips or shrinks."""
    if width not in C1_FACT_WIDTHS:
        return []
    return await page.evaluate("(cardless) => {" + C1_PRELUDE + r"""
      const fails = [];
      const lh = s => { const v = parseFloat(s.lineHeight); return Number.isNaN(v) ? parseFloat(s.fontSize) * 1.2 : v; };
      const facts = [...document.querySelectorAll('article [class*="__statsBlock___"] :is(dt, dd, small)')];
      if (!cardless && !facts.length) fails.push({why: 'no Now/Forecast facts found'});
      for (const e of facts) {
        const s = getComputedStyle(e), line = lh(s), r = e.getBoundingClientRect(), why = [];
        // Each element is measured on its own: a caption line is the small, never the dd that wraps it.
        const range = document.createRange(); range.selectNodeContents(e);
        const tops = [];
        for (const q of range.getClientRects()) if (q.width > 0 && !tops.some(t => Math.abs(t - q.top) < line / 2)) tops.push(q.top);
        if (!shown(e) || !e.checkVisibility({checkOpacity: true})) why.push('hidden');
        if (r.height > line * 1.5) why.push(`taller than 1.5 lines (${r.height.toFixed(1)} vs ${line.toFixed(1)})`);
        if (tops.length > 1) why.push(`wraps onto ${tops.length} lines`);
        if (s.textOverflow === 'ellipsis') why.push('ellipsis');
        if (s.display !== 'inline' && e.scrollWidth > e.clientWidth + 1) why.push('clipped or overflowing its box');
        if (parseFloat(s.fontSize) < 12) why.push('type below 12px');
        if (why.length) fails.push({tag: e.tagName, text: e.textContent.trim().slice(0, 60), why, ...box(e)});
      }
      return fails;
    }""", state in C1_CARDLESS)


async def check_header_action_labels(page, state, width):
    """I2: every visible graph-size or move button, open and minimized, shows its text whole."""
    measure_js = "(cardless) => {" + C1_PRELUDE + r"""
      const fails = [];
      const all = cards();
      if (!cardless && !all.length) fails.push({why: 'no cards found'});
      for (const card of all) {
        const buttons = actions(card);
        if (!buttons.length) fails.push({why: 'card has no visible action', card: card.querySelector('h2')?.textContent});
        for (const b of buttons) {
          const text = b.innerText.trim(), why = [];
          if (!text) why.push('no visible text');
          if (b.scrollWidth > b.clientWidth) why.push(`scrollWidth ${b.scrollWidth} > clientWidth ${b.clientWidth}`);
          for (const e of [b, ...b.querySelectorAll('*')]) if (getComputedStyle(e).textOverflow === 'ellipsis') why.push('text-overflow: ellipsis');
          if (why.length) fails.push({text: text || name(b), why, ...box(b)});
        }
      }
      return fails;
    }"""
    cardless = state in C1_CARDLESS
    fails = [dict(phase="open", **f) for f in await page.evaluate(measure_js, cardless)]
    toggles = page.locator('button[class*="__graphToggle___"]:visible')
    count = await toggles.count()
    for i in range(count):
        await toggles.nth(i).click()
    fails += [dict(phase="minimized", **f) for f in await page.evaluate(measure_js, cardless)]
    for i in range(count):
        await toggles.nth(i).click()
    return fails


async def check_toggle_consistency(page, state, width):
    """I3: the graph-size button has one height, font size and radius on every card."""
    readings = await page.evaluate("() => {" + C1_PRELUDE + r"""
      return [...document.querySelectorAll('button[class*="__graphToggle___"]')].filter(shown).map(b => {
        const s = getComputedStyle(b);
        return {card: b.closest('article, section')?.querySelector('h2')?.textContent, h: b.getBoundingClientRect().height, font: s.fontSize, radius: s.borderTopLeftRadius};
      });
    }""")
    if not readings:
        return [] if state in C1_CARDLESS else [dict(why="no graph-size buttons found")]
    first = readings[0]
    return [dict(why="differs from the first card's button", first=first, **r) for r in readings[1:]
            if abs(r["h"] - first["h"]) > 0.5 or r["font"] != first["font"] or r["radius"] != first["radius"]]


async def check_phone_header(page, state, width):
    """I4 (H1, page-wide since wave 3): at 390 the page makes one choice. If every provider card's title, count
    and chip fit on one line, every card keeps them inline (tops within 4px) and a card's top to the top of its
    headline block (label included) is at most 112px. Otherwise every card's chip sits on its own second line
    under the title and count (148px). The action pills sit on their own row between the two, and the headline
    starts below them."""
    if width != 390:
        return []
    return await page.evaluate("(cardless) => {" + C1_PRELUDE + r"""
      const fails = [], articles = [...document.querySelectorAll('article')];
      if (!cardless && !articles.length) fails.push({why: 'no provider cards found'});
      const top = e => e.getBoundingClientRect().top;
      const textWidth = e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width; };
      const parts = a => ({a, card: a.querySelector('h2')?.textContent, headline: a.querySelector('[class*="__headline___"]'), title: a.querySelector('h2'),
        count: a.querySelector('[class*="__poolMeta___"] > span:first-child'), chip: a.querySelector('[class*="__badge___"]')});
      const measured = articles.map(parts);
      // Whether one card's mark, title, count, chip and gaps fit its line (the chip alone may wrap inside its own box).
      const fit = m => {
        const cs = getComputedStyle(m.a), inner = m.a.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
        return {inner, need: 20 + textWidth(m.title) + textWidth(m.count) + m.chip.getBoundingClientRect().width + 3 * 8};
      };
      const whole = measured.filter(m => m.headline && m.title && m.count && m.chip);
      const allFit = whole.every(m => { const f = fit(m); return f.need <= f.inner; });
      for (const m of measured) {
        const {a, card, headline, title, count, chip} = m;
        if (!headline || !title || !count || !chip) { fails.push({card, why: 'card lacks a headline, title, count or chip'}); continue; }
        const tops = [title, count, chip].map(top), oneLine = Math.max(...tops) - Math.min(...tops) <= 4, limit = allFit ? 112 : 148;
        if (allFit && !oneLine) { const f = fit(m); fails.push({card, why: `every card's title, count and chip fit one line (${f.need.toFixed(0)} of ${f.inner.toFixed(0)}px here) but this card wraps`}); }
        if (!allFit) {
          if (top(chip) < Math.max(title.getBoundingClientRect().bottom, count.getBoundingClientRect().bottom) - 2) fails.push({card, why: 'a card does not fit one line, yet this chip is not on its own second line'});
          if (Math.abs(top(count) - top(title)) > 4) fails.push({card, why: 'the count left the title line'});
        }
        const d = top(headline) - top(a);
        if (d > limit) fails.push({card, why: `headline block starts ${d.toFixed(0)}px below the card top (limit ${limit}, ${allFit ? 'every card inline' : 'chips on a second line'})`});
        const pills = actions(a);
        if (!pills.length) fails.push({card, why: 'card has no visible action pills'});
        const bottom = Math.max(...pills.map(p => p.getBoundingClientRect().bottom));
        if (top(headline) < bottom) fails.push({card, why: 'headline block starts above the action pills end'});
        // Pills only on row 2: they start below the identity row, and every pill shares one row.
        const identityBottom = Math.max(...[title, count, chip].map(e => e.getBoundingClientRect().bottom));
        for (const p of pills) if (p.getBoundingClientRect().top < identityBottom - 1) fails.push({card, why: 'an action pill shares a row with the title, count or chip'});
        const pillTops = pills.map(top);
        if (pills.length && Math.max(...pillTops) - Math.min(...pillTops) > 2) fails.push({card, why: 'action pills are not on one row'});
        // Touch targets stay full size.
        for (const p of pills) if (p.getBoundingClientRect().height < 43.5) fails.push({card, why: `action pill ${p.getBoundingClientRect().height}px tall`});
        // Chip text is whole.
        if (chip.scrollWidth > chip.clientWidth + 1 || getComputedStyle(chip).textOverflow === 'ellipsis') fails.push({card, why: 'chip text is clipped'});
      }
      return fails;
    }""", state in C1_CARDLESS)


async def check_action_names(page, state, width):
    """I5: each action's accessible name starts with its visible text."""
    return await page.evaluate("(cardless) => {" + C1_PRELUDE + r"""
      const fails = [], all = cards();
      if (!cardless && !all.length) fails.push({why: 'no cards found'});
      for (const card of all) for (const b of actions(card)) {
        const text = b.innerText.trim(), label = name(b);
        if (!text || !label.toLowerCase().startsWith(text.toLowerCase())) fails.push({text, name: label, why: 'accessible name does not start with the visible text'});
      }
      return fails;
    }""", state in C1_CARDLESS)


async def check_header_order(page, state, width):
    """I6: no headline number sits on the same visual row as an action button."""
    return await page.evaluate("(cardless) => {" + C1_PRELUDE + r"""
      const fails = [], all = cards();
      if (!cardless && !all.length) fails.push({why: 'no cards found'});
      for (const card of all) {
        const n = card.querySelector('[class*="__headline___"] strong');
        if (!n || !shown(n)) { fails.push({card: card.querySelector('h2')?.textContent, why: 'card has no visible headline number'}); continue; }
        const q = n.getBoundingClientRect();
        for (const b of actions(card)) {
          const r = b.getBoundingClientRect();
          if (q.top < r.bottom && q.bottom > r.top) fails.push({card: card.querySelector('h2')?.textContent, action: b.innerText.trim(), why: 'headline number shares a row with an action'});
        }
      }
      return fails;
    }""", state in C1_CARDLESS)


# P1 polish checks (blind A/B concerns). Each has its own JSON key, registered in P1_KEYS for the summary and exit gate.
P1_KEYS = ("lowInlineFailures", "forecastRowFailures", "actionAlignFailures")
P1_FORECAST_WIDTHS = (1280, 1440, 1920)


async def check_low_inline(page, state):
    """P1.1: every visible low value shows its icon, "Low" and percentage on one line, unclipped."""
    if state in C3_NO_ROSTER:
        return []
    return await page.evaluate("() => {" + C3_HELPERS + r"""
      const out = [], values = [...document.querySelectorAll('article details > summary > strong[data-low="true"], article ul[aria-label="Limits"] li[data-low="true"] > strong')].filter(shown);
      if (!values.length) out.push({why: 'no visible low value in a case that has a roster'});
      for (const e of values) {
        const row = e.closest('details'), where = (row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent || '') + ' ' + (e.parentElement.tagName === 'LI' ? e.parentElement.firstElementChild.textContent : 'row value');
        const word = e.querySelector('[class*="__lowWord___"]'), pctNode = textNodeWith(e, /%/);
        if (!word || !pctNode) { out.push({where, why: 'missing "Low" word or percentage'}); continue; }
        const range = document.createRange(); range.selectNodeContents(pctNode);
        const w = word.getBoundingClientRect(), p = range.getBoundingClientRect(), box = row.getBoundingClientRect();
        if (Math.abs(w.top - p.top) > 4) out.push({where, why: `"Low" top ${w.top.toFixed(1)} vs percentage top ${p.top.toFixed(1)}`});
        for (const [what, r] of [['"Low"', w], ['percentage', p]]) if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push({where, why: `${what} leaves its row`});
        if (e.scrollWidth > Math.ceil(e.getBoundingClientRect().width) + 1 || word.scrollWidth > word.clientWidth + 1) out.push({where, why: 'value or "Low" clipped'});
      }
      return out;
    }""")


async def check_forecast_row(page, state, width):
    """P1.2: at 1280/1440/1920 the three Forecast facts share one row (tops within 4px)."""
    if width not in P1_FORECAST_WIDTHS or state in C1_CARDLESS:
        return []
    return await page.evaluate("() => {" + C1_PRELUDE + r"""
      const out = [], groups = [...document.querySelectorAll('article [class*="__statsBlock___"] > :last-child dl')].filter(shown);
      if (!groups.length) out.push({why: 'no Forecast facts found'});
      for (const dl of groups) {
        const facts = [...dl.children].filter(shown);
        if (facts.length !== 3) continue;
        const tops = facts.map(f => f.getBoundingClientRect().top);
        if (Math.max(...tops) - Math.min(...tops) > 4) out.push({card: dl.closest('article').querySelector('h2')?.textContent, why: 'Forecast facts on more than one row', tops: tops.map(Math.round)});
      }
      return out;
    }""")


async def check_action_align(page, state):
    """P1.4: where the card actions share the title's row, their centre is within 3px of the title text's centre."""
    if state in C1_CARDLESS:
        return []
    return await page.evaluate("() => {" + C1_PRELUDE + r"""
      const out = [], all = cards();
      if (!all.length) out.push({why: 'no cards found'});
      for (const card of all) {
        const group = card.querySelector('[class*="__reorder___"]'), h2 = card.querySelector('h2');
        if (!group || !h2 || !shown(group)) { out.push({why: 'card has no visible actions or title'}); continue; }
        const g = group.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(h2);
        const t = range.getBoundingClientRect();
        if (!(g.top < t.bottom && g.bottom > t.top)) continue;
        const d = Math.abs((g.top + g.bottom) / 2 - (t.top + t.bottom) / 2);
        if (d > 3) out.push({card: h2.textContent, why: `actions centre ${d.toFixed(1)}px from the title text centre`});
      }
      return out;
    }""")
# G geometry checks (Combined controls, rate headline). Each has its own JSON key,
# registered in G_KEYS for the summary and the exit gate. They run on pages of their own, opened at the
# widths and languages of G_SWEEPS, because one case has one viewport. A check that finds nothing to
# measure on a page where it applies fails.
G_KEYS = ("combinedControlsFailures", "rateHeadlineFailures")
G_WIDTHS = (390, 820, 1100, 1440)
# base case -> pages (fixture state, width, language, view to apply first)
G_SWEEPS = {
    "laptop": [("ready", w, "en", None) for w in (390, 820, 1100, 1280, 1440, 1920)],
    "many": [("many", w, "en", None) for w in G_WIDTHS]
    + [("many", w, lng, view) for lng in ("ru", "vi") for w in (390, 1100, 1440) for view in (None, "Drain rate")],
    "narrow": [("ready", 390, lng, view) for lng in ("ru", "vi") for view in (None, "Burn rate")],
    "drain": [("ready", w, "en", "Drain rate") for w in G_WIDTHS] + [("ready", 1440, "en", "Burn rate")],
}


async def open_fixture_page(browser, url, state, width, lng, view, height=1000):
    """A fresh page on the fixture, in `state` at `width`; `view` is pressed in English first, then the language is set."""
    context = await browser.new_context(
        viewport=dict(width=width, height=height), device_scale_factor=1, is_mobile=width < 600,
        has_touch=width < 600, locale="en-US", timezone_id="UTC", color_scheme="dark", reduced_motion="reduce",
    )
    page = await context.new_page()

    async def route_api(route):
        request_url = route.request.url
        if "/requests/api-call" in request_url:
            await route.fulfill(status=400, json={"error": "Unexpected provider call in cancel-only fixture"})
        elif "/credentials" in request_url:
            await route.fulfill(json={"files": []})
        elif "/prox/inventory" in request_url:
            await route.fulfill(json={"version": "fixture", "syncedAtMs": NOW, "sources": []})
        elif "/prox/refresh" in request_url:
            await route.fulfill(json=fixture(state))
        elif "/prox/pools" in request_url:
            query = parse_qs(urlparse(request_url).query)
            data = fixture(state)
            if "window" in query:
                data["window"] = query["window"][0]
            if "lookback" in query:
                data["lookbackHours"] = int(query["lookback"][0])
            await route.fulfill(json=data)
        else:
            await route.fulfill(json={})

    async def local_only(route):
        await (route.continue_() if route.request.url.startswith(url + "/") else route.abort())
    await context.route("**/*", local_only)
    await page.route("**/prox/sources.json", lambda route: route.fulfill(status=404))
    await page.route("**/v8/management/**", route_api)
    await page.goto(url, wait_until="networkidle")
    await page.evaluate("""async () => {
        const {useAuthStore}=await import('/src/stores/useAuthStore.ts');
        const {apiClient}=await import('/src/services/api/client.ts');
        const i18n=(await import('/src/i18n/index.ts')).default; await i18n.changeLanguage('en');
        apiClient.setConfig({apiBase:location.origin,managementKey:'visual-fixture-only'});
        useAuthStore.setState({isAuthenticated:true,connectionStatus:'connected',apiBase:location.origin,managementKey:'visual-fixture-only'});
        location.hash='/quota';
    }""")
    await page.locator("article").first.wait_for()
    if view:
        await switch_view(page, view)
    if lng != "en":
        await page.evaluate("async (lng) => { const i18n=(await import('/src/i18n/index.ts')).default; await i18n.changeLanguage(lng); }", lng)
    await page.evaluate("document.fonts.ready")
    await page.wait_for_timeout(250)
    return context, page


async def check_combined_controls(page, width):
    """G2: on the Combined card the chart-view select and the graph toggle follow the width rules (S1 on phones)."""
    return await page.evaluate("(width) => {" + C1_PRELUDE + r"""
      const card = document.querySelector('section[class*="__combined___"]'), fails = [];
      const select = card?.querySelector('select'), toggle = card?.querySelector('button[class*="__graphToggle___"]'), h2 = card?.querySelector('h2');
      if (!select || !toggle || !h2) return [{why: 'Combined card, select or toggle not found'}];
      const s = select.getBoundingClientRect(), t = toggle.getBoundingClientRect(), h = h2.getBoundingClientRect(), c = card.getBoundingClientRect(), cs = getComputedStyle(card);
      const edge = c.right - parseFloat(cs.paddingRight), centre = r => (r.top + r.bottom) / 2;
      if (width >= 901) {
        const gap = t.left - s.right;
        if (Math.abs(t.right - edge) > 2) fails.push({why: `toggle right edge ${(edge - t.right).toFixed(1)}px from the content edge`});
        if (gap < 0 || gap > 12) fails.push({why: `gap from select to toggle is ${gap.toFixed(1)}px`});
        if (Math.abs(centre(s) - centre(t)) > 2) fails.push({why: `select and toggle centres differ by ${Math.abs(centre(s) - centre(t)).toFixed(1)}px`});
      } else if (width <= 640) {
        if (Math.abs(h.top - t.top) > 4 && Math.abs(centre(h) - centre(t)) > 20) fails.push({why: `heading top ${h.top.toFixed(1)} vs toggle top ${t.top.toFixed(1)}`});
        if (s.top < Math.max(h.bottom, t.bottom) - 1) fails.push({why: 'select is not below the heading and toggle'});
      } else {
        if (s.top < Math.max(h.bottom, t.bottom) - 1) fails.push({why: 'select is not on its own row'});
        if (Math.abs(s.right - edge) > 2) fails.push({why: `select right edge ${(edge - s.right).toFixed(1)}px from the content edge`});
      }
      return fails;
    }""", width)


async def check_rate_headline(page):
    """G3: in a rate view every headline reads label, then number; the label is one line above the number and
    "points/h" shares the number's baseline. A withheld headline keeps its word and label and shows no number or unit."""
    return await page.evaluate("() => {" + C1_PRELUDE + r"""
      const fails = []; let measured = 0;
      for (const card of cards()) {
        const h = card.querySelector('[class*="__headline___"]'), who = card.querySelector('h2')?.textContent;
        if (!h) { fails.push({who, why: 'card has no headline'}); continue; }
        if (h.dataset.rate !== 'true') { fails.push({who, why: 'headline is not in the rate layout'}); continue; }
        const strong = h.querySelector('strong'), label = h.querySelector('[class*="__metricLabel___"]'), unit = strong.querySelector('small');
        if (!label || !shown(label)) { fails.push({who, why: 'headline has no metric label'}); continue; }
        if (!unit) {
          if (/\d|points/.test(strong.textContent)) fails.push({who, why: 'withheld headline shows a number or unit'});
          if (!strong.textContent.trim()) fails.push({who, why: 'withheld headline has no status word'});
          continue;
        }
        measured++;
        if (!(label.compareDocumentPosition(strong) & Node.DOCUMENT_POSITION_FOLLOWING)) fails.push({who, why: 'label does not come before the number in the DOM'});
        const probe = () => { const p = document.createElement('span'); p.style.cssText = 'display:inline-block;width:0;height:0'; return p; };
        const numberProbe = probe(), unitProbe = probe();
        strong.insertBefore(numberProbe, unit); unit.appendChild(unitProbe);
        const drift = Math.abs(numberProbe.getBoundingClientRect().bottom - unitProbe.getBoundingClientRect().bottom);
        numberProbe.remove(); unitProbe.remove();
        if (drift > 2) fails.push({who, why: `unit baseline ${drift.toFixed(1)}px off the number's`});
        const ls = getComputedStyle(label), lh = parseFloat(ls.lineHeight) || parseFloat(ls.fontSize) * 1.2, l = label.getBoundingClientRect();
        if (l.height > lh * 1.5) fails.push({who, why: `label ${l.height.toFixed(1)}px tall, over 1.5 lines of ${lh.toFixed(1)}px`});
        if (l.bottom > strong.getBoundingClientRect().top + 0.5) fails.push({who, why: 'label is not above the number'});
      }
      if (!measured) fails.push({why: 'no rate headline with a number to measure'});
      return fails;
    }""")


async def run_g_checks(browser, url, name, state, page, result):
    """Run the G checks for a case: the rate headline on its own page, then every page of its G_SWEEPS entry."""
    for key in G_KEYS:
        result[key] = []
    if state in ("drain", "burn"):
        result["rateHeadlineFailures"] += [dict(page="case page", **f) for f in await check_rate_headline(page)]
    for sweep_state, width, lng, view in G_SWEEPS.get(name, ()):
        context, sweep = await open_fixture_page(browser, url, sweep_state, width, lng, view)
        try:
            tag = f"{sweep_state}/{view or 'remaining'}@{width}/{lng}"
            result["combinedControlsFailures"] += [dict(page=tag, **f) for f in await check_combined_controls(sweep, width)]
            if view in ("Drain rate", "Burn rate"):
                result["rateHeadlineFailures"] += [dict(page=tag, **f) for f in await check_rate_headline(sweep)]
        finally:
            await context.close()
# R roster checks (counts, filter chip, phone toolbar). Each has its own JSON key, registered in R_KEYS for the
# summary and the exit gate. They open a fresh page of their own (so the filters they flip never leak into the
# case's screenshots) and apply the case's own initial roster state. A check that finds nothing to measure fails.
R_KEYS = ("rosterCountFailures", "filterChipFailures", "rosterToolbarFailures")
R_LANGS = ("ru", "vi")
# ru and vi run where a roster exists: `many` and its phone twin (the `narrow` fixture has five accounts, no toolbar).
R_LANG_CASES = ("many", "many-narrow")
R_COUNT_CASES = ("many", "many-low", "many-lowest", "partial-affected-narrow", "many-narrow", "many-search-narrow")
R_CHIP_CASES = ("many", "many-low", "many-narrow", "partial-affected-narrow")
R_TOOLBAR_CASES = ("many-narrow", "many-search-narrow")
R_PAGE = 25  # rows before "Show more"
R_NO_MATCH = "zzzz-no-such-account"
R_LOW = 20  # a limit below this many percent is low (the UI's own rule)
# The exact count strings the app must show, written out here rather than read from the locales.
# A tuple is (singular form, other form) where the language has two; a language with one form has a 1-tuple.
R_COUNT_TEXT = {
    "en": dict(shown="{d} of {t} shown", only=("{f} of {t} matches", "{f} of {t} match"),
               some=("{d} of {f} match shown · {t} total", "{d} of {f} matches shown · {t} total"),
               none="No matches · {t} total"),
    "ru": dict(shown="Показано {d} из {t}", only=("Совпадает {f} из {t}", "Совпадают {f} из {t}"),
               some=("Показано {d} из {f} совпадения · всего {t}", "Показано {d} из {f} совпадений · всего {t}"),
               none="Нет совпадений · всего {t}"),
    "vi": dict(shown="Hiển thị {d} / {t}", only=("Khớp {f} / {t}",), some=("Hiển thị {d} / {f} kết quả khớp · tổng {t}",),
               none="Không có kết quả khớp · tổng {t}"),
}


def r_form(lng, n):
    """Index of the form for the integer n: 0 for "one" (ru: 1, 21, 31... but not 11), 1 for everything else."""
    if lng == "en":
        return 0 if n == 1 else 1
    if lng == "ru":
        return 0 if n % 10 == 1 and n % 100 != 11 else 1
    return 0


def r_expected_text(lng, d, f, t, filtering):
    """The count string for D rows shown, F matches and T accounts (see the spec's four-row table)."""
    text = R_COUNT_TEXT[lng]
    if not filtering:
        return text["shown"].format(d=d, t=t)
    if f == 0:
        return text["none"].format(t=t)
    forms = text["some"] if d < f else text["only"]
    return forms[min(r_form(lng, f), len(forms) - 1)].format(d=d, f=f, t=t)


def r_expected(state, provider, flt, show_all):
    """D, F and T for a provider, derived from the fixture accounts and the active search or filter, not from the page."""
    pool = next(p for p in fixture(state)["pools"] if p["provider"] == provider)
    query = flt["query"].strip().lower()
    broken = ("error", "missing-window") if pool["forecastState"] == "partial" else ("stale",) if pool["forecastState"] == "stale" else ()
    matched = [a for a in pool["accounts"]
               if (not query or query in a["identifier"].lower())
               and (not flt["low"] or any(w["remainingPercent"] is not None and w["remainingPercent"] < R_LOW for w in a["windows"]))
               and (not flt["affected"] or a["status"] in broken)]
    f, t = len(matched), len(pool["accounts"])
    return dict(d=f if show_all else min(f, R_PAGE), f=f, t=t, filtering=bool(query or flt["low"] or flt["affected"]))
R_JS = r"""
const shown = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.checkVisibility({checkVisibilityCSS: true}); };
const countOf = text => (text.match(/\d+(?![\d%])/g) || []).map(Number);
const toolsIn = a => a.querySelector('[class*="__rosterTools___"]');
"""


async def r_page(context, url, route_api, state, lng):
    """A fresh Quota page in `lng`, with the case's own starting roster state (low chip on, search typed, affected shown)."""
    page = await context.new_page()
    await page.route("**/prox/sources.json", lambda route: route.fulfill(status=404))
    await page.route("**/v8/management/**", route_api)
    await page.goto(url, wait_until="networkidle")
    await page.evaluate("""async (lng) => {
        const {useAuthStore}=await import('/src/stores/useAuthStore.ts');
        const {apiClient}=await import('/src/services/api/client.ts');
        const i18n=(await import('/src/i18n/index.ts')).default; await i18n.changeLanguage(lng);
        apiClient.setConfig({apiBase:location.origin,managementKey:'visual-fixture-only'});
        useAuthStore.setState({isAuthenticated:true,connectionStatus:'connected',apiBase:location.origin,managementKey:'visual-fixture-only'});
        location.hash='/quota';
    }""", lng)
    await page.locator('[class*="QuotaPoolPage"][class*="__page___"]').wait_for()
    await page.locator("article").first.wait_for()
    if state == "many-low":
        await page.locator('article [class*="__rosterLow___"]').first.click()
    if state == "many-search":
        await page.locator('article input[type="search"]').first.fill("gra")
    if state == "partial":
        await page.get_by_role("button", name="Show affected accounts").first.click()
    await page.wait_for_timeout(150)
    return page


async def r_cards(page):
    """Indexes (and providers) of the provider cards that carry a roster toolbar."""
    return await page.evaluate("() => {" + R_JS + r"""
      return [...document.querySelectorAll('article')].map((a, i) => toolsIn(a) ? {i, provider: /__codex___/.test(a.className) ? 'codex' : 'claude'} : null).filter(Boolean);
    }""")


R_SNAP = "(i) => {" + R_JS + r"""
  const a = document.querySelectorAll('article')[i], tools = toolsIn(a);
  const counts = [...tools.querySelectorAll('[class*="__rosterCount___"]')], footer = a.querySelector('[class*="__rosterFooter___"]');
  const chips = [...tools.querySelectorAll('[class*="__rosterLow___"]')], low = chips[chips.length - 1] || null;
  const more = footer && footer.querySelector('button');
  return {
    text: counts[0] ? counts[0].textContent.trim() : '', inTools: counts.length, inCard: a.querySelectorAll('[class*="__rosterCount___"]').length,
    last: !!counts[0] && tools.lastElementChild === counts[0],
    rows: [...a.querySelectorAll('details[class*="__account___"]')].filter(shown).length,
    moreN: more ? (countOf(more.textContent)[0] || 0) : 0, footerKids: footer ? footer.children.length : 0,
    query: tools.querySelector('input[type="search"]')?.value || '',
    lowPressed: !!low && low.getAttribute('aria-pressed') === 'true', chipN: low ? (countOf(low.textContent)[0] ?? -1) : -1, hasChip: !!low,
  };
}"""


def r_count_verify(out, card, step, s, want, lng):
    """Check one reading of a count against the fixture-derived D, F and T, as an exact string."""
    where = dict(card=card, lng=lng, step=step, text=s["text"])
    found = (s["inTools"], s["inCard"], s["last"])
    if found != (1, 1, True):
        out.append(dict(where, why=f"count elements (in toolbar, in card, is last item) = {found}"))
    if s["footerKids"] > 1:
        out.append(dict(where, why="the footer still holds more than the Show more button"))
    expected = r_expected_text(lng, want["d"], want["f"], want["t"], want["filtering"])
    if s["text"] != expected:
        out.append(dict(where, why=f"expected {expected!r} (D={want['d']}, F={want['f']}, T={want['t']})"))
    if s["rows"] != want["d"]:
        out.append(dict(where, why=f"{s['rows']} rows on screen but D = {want['d']}"))
    if s["moreN"] != want["f"] - want["d"]:
        out.append(dict(where, why=f"Show more offers {s['moreN']} but {want['f'] - want['d']} matches are hidden"))
    if s["lowPressed"] and not s["query"] and s["chipN"] != want["f"]:
        out.append(dict(where, why=f"the low filter's chip says {s['chipN']} but {want['f']} rows match"))


async def _roster_counts(page, lng, state):
    out = []
    cards = await r_cards(page)
    if not cards:
        return [dict(lng=lng, why="no roster toolbar found")]
    for c in cards:
        art, card = page.locator("article").nth(c["i"]), c["provider"]
        # The filters this case starts with (see r_page); the steps below flip them and track the change.
        # r_page applies them to the first card only.
        first = c is cards[0]
        flt = dict(low=first and state == "many-low", query="gra" if first and state == "many-search" else "", affected=first and state == "partial")
        show_all = False

        async def settle(step):
            s = await page.evaluate(R_SNAP, c["i"])
            r_count_verify(out, card, step, s, r_expected(state, card, flt, show_all), lng)
            return s

        s = await settle("initial")
        if s["moreN"]:
            await art.locator('[class*="__rosterFooter___"] button').click()
            show_all = True
            s = await settle("after Show more")
        elif s["rows"] > R_PAGE:
            out.append(dict(card=card, lng=lng, why="more than a page of rows without Show more"))
        search = art.locator('input[type="search"]')
        if not await search.count():
            continue  # a short roster: only its affected-only count exists, and the initial step measured it
        if not s["hasChip"]:
            out.append(dict(card=card, lng=lng, why="no low-limit chip to filter with"))
            continue
        chip = art.locator('[class*="__rosterLow___"]').last
        for step in ("after toggling the filter", "after toggling it back"):
            await chip.click()
            flt["low"] = not flt["low"]
            await settle(step)
        flt["query"] = R_NO_MATCH
        await search.fill(R_NO_MATCH)
        s = await settle("zero-result search")
        if s["rows"] != 0:
            out.append(dict(card=card, lng=lng, why="a search with no match should show 0 rows", text=s["text"]))
        flt["query"] = ""
        await search.fill("")
        await settle("search cleared")
        flt["query"] = "gra"
        await search.fill("gra")
        s = await settle("search")
        if not s["rows"]:
            out.append(dict(card=card, lng=lng, why="the search 'gra' matched nothing, so no filtered count was measured"))
        if await art.locator('[class*="__rosterLow___"]').count():
            await art.locator('[class*="__rosterLow___"]').last.click()
            flt["low"] = not flt["low"]
            await settle("search + filter")
            await art.locator('[class*="__rosterLow___"]').last.click()
            flt["low"] = not flt["low"]
        else:
            out.append(dict(card=card, lng=lng, why="no low-limit chip while searching, so search + filter was not measured"))
        flt["query"] = ""
        await search.fill("")
        await settle("cleared")
    return out


async def check_roster_count(context, url, route_api, name, state):
    """R1/A1: every roster toolbar shows one count as its last item and nowhere else, and its exact text follows
    D (rows on screen), F (matches) and T (all accounts), each derived from the fixture and the active filters:
    "D of T shown"; "D of F matches shown · T total" (D < F); "F of T match(es)" (D == F); "No matches · T total".
    Low-only, affected-only, search, search + filter, zero matches, Show more and cleared are all read. ru and vi
    repeat it on the cases with a roster."""
    if name not in R_COUNT_CASES:
        return []
    out = []
    for lng in ("en", *(R_LANGS if name in R_LANG_CASES else ())):
        page = await r_page(context, url, route_api, state, lng)
        try:
            out += await _roster_counts(page, lng, state)
        finally:
            await page.close()
    return out


def r_lab(rgb):
    """sRGB -> CIE L*a*b* (D65)."""
    lin = [v / 255 / 12.92 if v / 255 <= 0.04045 else ((v / 255 + 0.055) / 1.055) ** 2.4 for v in rgb]
    x, y, z = (sum(m * c for m, c in zip(row, lin)) for row in (
        (0.4124, 0.3576, 0.1805), (0.2126, 0.7152, 0.0722), (0.0193, 0.1192, 0.9505)))
    f = lambda v: v ** (1 / 3) if v > 216 / 24389 else (24389 / 27 * v + 16) / 116
    fx, fy, fz = f(x / 0.95047), f(y), f(z / 1.08883)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def r_delta_e(a, b):
    return math.dist(r_lab(a), r_lab(b))


async def r_chip_paint(chip):
    """Sample the chip's rendered pixels: the card just outside its rounded corner, its fill inside the padding, and
    its border (the edge pixel farthest from the fill along the top edge)."""
    import io
    await chip.scroll_into_view_if_needed()
    await chip.page.mouse.move(0, 0)  # a hovered chip is drawn lighter than a resting one
    await chip.page.wait_for_timeout(120)
    im = Image.open(io.BytesIO(await chip.screenshot(animations="disabled"))).convert("RGB")
    w, h = im.size
    fill = im.getpixel((7, h // 2))
    border = max((im.getpixel((w // 2, y)) for y in range(0, min(3, h))), key=lambda p: r_delta_e(p, fill))
    return dict(card=im.getpixel((0, 0)), fill=fill, border=border)


R_CHIP_STATE = "(el) => {" + R_JS + r"""
  const svg = el.querySelector('svg'), b = svg ? svg.getBoundingClientRect() : null;
  return {text: el.textContent.trim(), pressed: el.getAttribute('aria-pressed'), icon: !!svg && shown(svg) && b.width >= 12 && b.height >= 12,
          n: countOf(el.textContent)[0] ?? -1};
}"""


async def _chip_flip(page, chip):
    """Read the chip in the state it is in, press it, read it again; return {pressed: reading}."""
    seen = {}
    for _ in range(2):
        s = await chip.evaluate(R_CHIP_STATE)
        s.update(await r_chip_paint(chip))
        seen[s["pressed"]] = s
        await chip.click()
        await page.wait_for_timeout(100)
    return seen


async def _chip_checks(page, lng, out):
    cards = await r_cards(page)
    if not cards:
        return out.append(dict(lng=lng, why="no roster toolbar found"))
    for c in cards:
        art = page.locator("article").nth(c["i"])
        chip = art.locator('[class*="__rosterLow___"]').last
        who = dict(card=c["provider"], lng=lng)
        if not await chip.count():
            out.append(dict(who, why="no low-limit chip to toggle"))
            continue
        seen = await _chip_flip(page, chip)
        if set(seen) != {"true", "false"}:
            out.append(dict(who, why=f"toggling reached states {sorted(seen)}, not both"))
            continue
        on, off = seen["true"], seen["false"]
        labels = await page.evaluate("""async (n) => { const i18n = (await import('/src/i18n/index.ts')).default;
            return {off: i18n.t('quota_pool.accounts_low', {count: n[0]}), on: i18n.t('quota_pool.accounts_low_on', {count: n[1]}), enOff: i18n.t('quota_pool.accounts_low', {count: n[0], lng: 'en'})}; }""", [off["n"], on["n"]])
        if off["text"] != labels["off"] or on["text"] != labels["on"]:
            out.append(dict(who, why="chip label is not the translated 'Show…' (off) / 'Filtering to…' (on) text", off=off["text"], on=on["text"]))
        if lng == "en":
            if not (re.match(r"Show\b", off["text"]) and re.fullmatch(r"Show \d+ with a limit below 20%", off["text"])):
                out.append(dict(who, why="off label is not 'Show N with a limit below 20%'", text=off["text"]))
            if not (re.match(r"Filtering\b", on["text"]) and re.fullmatch(r"Filtering to \d+ with a limit below 20%", on["text"])):
                out.append(dict(who, why="on label is not 'Filtering to N with a limit below 20%'", text=on["text"]))
        else:
            if off["text"] == labels["enOff"]:
                out.append(dict(who, why="off label is still the English text", text=off["text"]))
            if on["text"] == off["text"]:
                out.append(dict(who, why="on and off labels are identical", text=on["text"]))
        if (off["pressed"], on["pressed"]) != ("false", "true"):
            out.append(dict(who, why="aria-pressed is not false when off and true when on"))
        if not (off["icon"] and on["icon"]):
            out.append(dict(who, why="the chip's icon is not visible in both states", off=off["icon"], on=on["icon"]))
        de = r_delta_e(on["fill"], off["fill"])
        contrast = max(ratio(on["border"], on["card"]), ratio(on["fill"], on["card"]))
        if de < 12:
            out.append(dict(who, why=f"on fill differs from the off fill by only dE {de:.1f}", on=on["fill"], off=off["fill"]))
        if contrast < 3:
            out.append(dict(who, why=f"the on chip's border/fill has contrast {contrast:.2f}:1 against the card (< 3:1)", border=on["border"], card=on["card"]))


async def _affected_chip(page, out):
    """The affected chip keeps its wording and takes the same filled style when on."""
    chip = page.locator('article [class*="__rosterLow___"]').first
    if not await chip.count():
        return out.append(dict(why="no affected chip after Show affected accounts"))
    s = await chip.evaluate(R_CHIP_STATE)
    s.update(await r_chip_paint(chip))
    if not re.fullmatch(r"Affected \(\d+\)", s["text"]):
        out.append(dict(why="affected chip wording changed", text=s["text"]))
    if s["pressed"] != "true" or not s["icon"]:
        out.append(dict(why="affected chip is not aria-pressed with a visible icon", state=s["pressed"], icon=s["icon"]))
    if r_delta_e(s["fill"], s["card"]) < 12:
        out.append(dict(why="affected chip fill is not the filled selected style", fill=s["fill"], card=s["card"]))
    if max(ratio(s["border"], s["card"]), ratio(s["fill"], s["card"])) < 3:
        out.append(dict(why="affected chip border has under 3:1 contrast against the card"))


async def check_filter_chip(context, url, route_api, name, state):
    """R2: the low chip reads "Show N with a limit below 20%" off and "Filtering to N with a limit below 20%" on, with
    aria-pressed, the icon and the page's selected-segment fill (dE >= 12 from off, a 3:1 border or fill against the
    card) in each state. The affected chip keeps "Affected (N)" and takes the same fill."""
    if name not in R_CHIP_CASES:
        return []
    out = []
    if name == "partial-affected-narrow":
        page = await r_page(context, url, route_api, state, "en")
        try:
            await _affected_chip(page, out)
        finally:
            await page.close()
        return out
    for lng in ("en", *(R_LANGS if name in R_LANG_CASES else ())):
        page = await r_page(context, url, route_api, state, lng)
        try:
            await _chip_checks(page, lng, out)
        finally:
            await page.close()
    return out


R_TOOLBAR = "() => {" + R_JS + r"""
  const out = [], tools = [...document.querySelectorAll('article')].map(toolsIn).filter(Boolean), canvas = document.createElement('canvas').getContext('2d');
  if (!tools.length) return [{why: 'no roster toolbar found'}];
  const kind = e => e.matches('label') && e.querySelector('input[type="search"]') ? 'search' : e.tagName === 'SELECT' ? 'sort' : e.tagName === 'BUTTON' ? 'chip' : e.matches('[class*="__rosterCount___"]') ? 'count' : 'other';
  for (const t of tools) {
    const card = t.closest('article').querySelector('h2')?.textContent, kids = [...t.children].filter(shown), kinds = kids.map(kind).join();
    if (!/^search,sort(,chip)+,count$/.test(kinds)) { out.push({card, why: 'controls are not search, sort, chip(s), count', kinds}); continue; }
    const rects = kids.map(k => k.getBoundingClientRect()), s = rects[0];
    kids.forEach((k, j) => {
      const r = rects[j], what = kind(k) + ' ' + (k.textContent.trim().slice(0, 30) || k.getAttribute('aria-label') || '');
      if (kind(k) !== 'count' && (Math.abs(r.left - s.left) > 2 || Math.abs(r.right - s.right) > 2)) out.push({card, what, why: `edges ${r.left.toFixed(1)}-${r.right.toFixed(1)} vs search ${s.left.toFixed(1)}-${s.right.toFixed(1)}`});
      if (kind(k) === 'count' && Math.abs(r.left - s.left) > 2) out.push({card, what, why: 'count does not start at the search field\'s left edge'});
      if (j && r.top < rects[j - 1].bottom - 1) out.push({card, what, why: 'overlaps or sits beside the control before it'});
      if (kind(k) !== 'count' && r.height < 43.5) out.push({card, what, why: `target is ${r.height.toFixed(1)}px tall, not 44`});
      const st = getComputedStyle(k);
      if (k.scrollWidth > k.clientWidth + 1 || (kind(k) === 'chip' && k.scrollHeight > k.clientHeight + 1)) out.push({card, what, why: 'content is clipped'});
      if (kind(k) === 'chip' || kind(k) === 'count') {
        const range = document.createRange(); range.selectNodeContents(k);
        for (const q of range.getClientRects()) if (q.left < r.left - 0.5 || q.right > r.right + 0.5 || q.top < r.top - 0.5 || q.bottom > r.bottom + 0.5) { out.push({card, what, why: 'text leaves its box'}); break; }
      }
      if (kind(k) === 'sort' || kind(k) === 'search') {
        // The search field is a label wrapping its input: the visible label must fit with 48px left to type in.
        const label = kind(k) === 'search' ? k.querySelector('span') : null;
        canvas.font = label ? getComputedStyle(label).font : st.font;
        const text = kind(k) === 'sort' ? k.selectedOptions[0].textContent : label.textContent, room = r.width - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight) - (kind(k) === 'sort' ? 24 : 48);
        if (canvas.measureText(text).width > room) out.push({card, what, why: `"${text}" is wider than its ${room.toFixed(0)}px of room`});
      }
    });
  }
  return out;
}"""


async def check_roster_toolbar(context, url, route_api, name, state):
    """R3 (390 and 320px, then ru and vi): search, sort and each chip run the search field's width, in that order, then the
    count; 44px targets, nothing overlapping or clipped. Measured twice: chips off, then the low chip on (its longer wording)."""
    if name not in R_TOOLBAR_CASES:
        return []
    out = []
    for lng in ("en", *R_LANGS):
        page = await r_page(context, url, route_api, state, lng)
        try:
            for width in (390, 320):
                await page.set_viewport_size(dict(width=width, height=844))
                await page.wait_for_timeout(150)
                out += [dict(f, lng=lng, width=width, chips="as loaded") for f in await page.evaluate(R_TOOLBAR)]
                chip = page.locator('article [class*="__rosterLow___"]').last
                if not await chip.count():
                    continue
                if await chip.get_attribute("aria-pressed") != "true":
                    await chip.click()
                    await page.wait_for_timeout(150)
                    out += [dict(f, lng=lng, width=width, chips="low chip on") for f in await page.evaluate(R_TOOLBAR)]
                    await chip.click()
        finally:
            await page.close()
    return out


OPTIONS_BUTTON = 'button[aria-controls="pool-view-options"]'


async def switch_view(page, name):
    """Press a view-setting button. Phones fold those buttons into the Options overlay, so open it
    first and close it again; the captured state then matches the wide layouts' (overlay closed)."""
    toggle = page.locator(OPTIONS_BUTTON)
    folded = await toggle.is_visible()
    if folded:
        await toggle.click()
        assert await toggle.get_attribute("aria-expanded") == "true"
    await page.get_by_role("button", name=name, exact=True).click()
    if folded:
        await toggle.click()
        assert await toggle.get_attribute("aria-expanded") == "false"


async def check_toolbar_budget(page, name, result):
    """I1: at 390x844 the Combined headline number starts no lower than 470px (420px when the
    Options summary shares the date row). The measured value is kept in result["toolbarBudget"]."""
    if name != "narrow":
        return []
    headline = page.get_by_role("region", name="Combined usage", exact=True).locator('[class*="__headline___"] strong')
    if not await headline.count():
        return [dict(why="Combined headline not found")]
    top = await page.evaluate(
        """el => el.getBoundingClientRect().top + (document.querySelector('.content')?.scrollTop || 0)""",
        await headline.first.element_handle(),
    )
    same_row = await page.evaluate("""() => {
        const b = document.querySelector('button[aria-controls="pool-view-options"]').getBoundingClientRect();
        const t = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Today').getBoundingClientRect();
        return Math.abs(b.top - t.top) < 8;
    }""")
    limit = 420 if same_row else 470
    result["toolbarBudget"] = dict(headlineTop=round(top, 1), limit=limit, summaryOnDateRow=same_row)
    return [dict(why="headline below budget", **result["toolbarBudget"])] if top > limit else []


async def check_options_summary(page, name, state, width):
    """I2: the Options button spells out the window, the measure and the averaging interval, plus a
    non-default Future (the narrow case sets one and puts it back)."""
    if width >= 600 or state in ("empty", "loading", "error"):
        return []
    toggle = page.locator(OPTIONS_BUTTON)
    if not await toggle.is_visible():
        return [dict(why="Options button not visible")]
    rate_view = state in ("drain", "burn")
    # Remaining names its Future assumption ("Same as now" by default); rate views hide Future, so they omit it.
    expected = ["5-hour" if state == "no-limit" else "Weekly", "Drain rate" if state == "drain" else "Burn rate" if state == "burn" else "Remaining", "3h"]
    if not rate_view:
        expected.append("Same as now")
    failures = []
    text = await toggle.inner_text()
    failures += [dict(why=f"summary lacks {item!r}", text=text) for item in expected if item not in text]
    if rate_view and ("Same as now" in text or "Future" in text):
        failures.append(dict(why="a rate view's summary names Future, which it hides", text=text))
    box = await toggle.bounding_box()
    if box["height"] < 43.5:
        failures.append(dict(why="Options button under 44px tall", box=box))
    if await toggle.evaluate("b => [...b.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') || b.scrollWidth > b.clientWidth + 1"):
        failures.append(dict(why="Options summary is clipped", text=text))
    if name == "narrow":
        await toggle.click()
        future = page.get_by_role("combobox", name="Future", exact=True)
        await future.select_option("Half")
        text = await toggle.inner_text()
        if "Half" not in text:
            failures.append(dict(why="summary lacks the non-default Future", text=text))
        await future.select_option("Same as now")
        await toggle.click()
    return failures


async def check_options_overlay(page, name):
    """I3 (390px): open with the keyboard, focus lands on the first control, the overlay hangs under
    the button without moving the page, stays reachable across 640/641px, Escape and an outside tap
    close it, and Escape returns focus to the button."""
    if name != "narrow":
        return []
    failures = []
    toggle, overlay = page.locator(OPTIONS_BUTTON), page.locator("#pool-view-options")
    heights = "[document.documentElement.scrollHeight, document.querySelector('.content')?.scrollHeight]"
    before = await page.evaluate(heights)
    await toggle.focus()
    await page.keyboard.press("Enter")
    if await toggle.get_attribute("aria-expanded") != "true" or not await overlay.is_visible():
        return [dict(why="keyboard did not open the overlay")]
    if not await page.evaluate("document.activeElement === document.querySelector('#pool-view-options').querySelector('button, select')"):
        failures.append(dict(why="focus is not on the first control"))
    if await page.evaluate(heights) != before:
        failures.append(dict(why="page height changed on open", before=before))
    box, anchor, viewport = await overlay.bounding_box(), await toggle.bounding_box(), page.viewport_size["width"]
    if box["y"] < anchor["y"] + anchor["height"] - 1 or abs(box["width"] - (viewport - 32)) > 1:
        failures.append(dict(why="overlay is not anchored under the button at viewport - 32px", box=box, anchor=anchor))
    if not await overlay.evaluate("o => o.contains(document.elementFromPoint(o.getBoundingClientRect().x + 20, o.getBoundingClientRect().y + 20))"):
        failures.append(dict(why="overlay is under other content"))
    for crossing in (641, 640):
        await page.set_viewport_size(dict(width=crossing, height=page.viewport_size["height"]))
        await page.wait_for_timeout(100)
        reachable = await overlay.evaluate("o => { const c = [...o.querySelectorAll('button, select')]; return c.length === 7 && c.every(e => e.checkVisibility()); }")
        if not reachable:
            failures.append(dict(why=f"a control is unreachable at {crossing}px"))
    await page.set_viewport_size(dict(width=viewport, height=page.viewport_size["height"]))
    await page.keyboard.press("Escape")
    if await toggle.get_attribute("aria-expanded") != "false" or await overlay.is_visible():
        failures.append(dict(why="Escape did not close the overlay"))
    if not await toggle.evaluate("b => document.activeElement === b"):
        failures.append(dict(why="focus did not return to the button after Escape"))
    await page.keyboard.press("Enter")
    heading = await page.locator("h1").bounding_box()
    await page.touchscreen.tap(heading["x"] + heading["width"] / 2, heading["y"] + heading["height"] / 2)
    if await toggle.get_attribute("aria-expanded") != "false" or await overlay.is_visible():
        failures.append(dict(why="an outside tap did not close the overlay"))
    return failures


# H phone checks (round h1). phoneHeaderFailures (above, in C1_KEYS) is the fourth; these three are new. Each has
# its own JSON key, registered in H_KEYS for the summary and the exit gate. A check that finds nothing to measure
# in a case where it applies fails.
H_KEYS = ("expandedDuplicateFailures", "phonePanelOrderFailures", "skeletonShapeFailures")
H_PRELUDE = C1_PRELUDE + r"""
const activeId = (article, view) => view === 'five-hour' ? 'five-hour' : /__claude___/.test(article.className) ? 'seven-day' : 'weekly';
"""


async def h_expand_all(page):
    """Open every row: each click renames its button to "Collapse all", so always take the first still closed."""
    for _ in range(await page.get_by_role("button", name="Expand all").count()):
        await page.get_by_role("button", name="Expand all").first.click()
    await page.wait_for_timeout(150)


async def check_expanded_duplicates(page, state, width):
    """H2 (rewritten in wave 3): in an opened row at 900px and below, the active window is listed once, as the first
    block, with its own value, bar and reset; the header has no bold figure and no "{Window} · Resets" line; every
    other limit keeps its value, bar and reset. Run at 390 and 820 in the Weekly and 5-hour views."""
    if width > 900 or state not in ("expanded", "partial"):
        return []
    measure = "(view) => {" + H_PRELUDE + r"""
      const fails = [], rows = [...document.querySelectorAll('article details[open]')];
      if (!rows.length) return [{why: 'no open row to measure'}];
      let others = 0;
      for (const row of rows) {
        const article = row.closest('article'), active = activeId(article, view), summary = row.querySelector('summary');
        const who = (row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent || '') + ' / ' + view;
        const items = [...row.querySelectorAll('ul[aria-label="Limits"] > li')];
        const activeItem = items.find(li => li.dataset.limitId === active);
        if (!activeItem) { fails.push({who, why: 'no list item carries data-limit-id for the active window'}); continue; }
        // Wave 3: the active window is listed once, as the first block (value, bar and reset included), and the
        // header neither repeats it as a bold figure nor carries a "{window} · Resets" line.
        const listed = items.filter(li => li.dataset.limitId === active && shown(li));
        if (listed.length !== 1) fails.push({who, why: `the active window is listed ${listed.length} times, expected once`});
        const firstBlock = items.filter(shown).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (firstBlock !== activeItem) fails.push({who, why: 'the active window is not the first block'});
        const small = activeItem.querySelector('small');
        if (small && !shown(small)) fails.push({who, why: 'the active window lost its reset line'});
        const heading = summary.querySelector(':scope > strong');
        if (shown(heading)) fails.push({who, why: 'the bold header figure is still shown'});
        if ([...summary.children].some(c => c.tagName !== 'UL' && shown(c) && / · Resets /.test(c.textContent))) fails.push({who, why: 'the header still carries a "{window} · Resets" line'});
        if (!shown(activeItem.querySelector(':scope > strong, :scope > em'))) fails.push({who, why: 'the active block lost its value or reason'});
        for (const li of items.filter(li => li.dataset.limitId !== active && !li.dataset.missing)) {
          others++;
          const v = li.querySelector(':scope > strong'), empty = /^—$/.test(v.textContent.trim());
          if (!shown(li) || !shown(v)) { fails.push({who, limit: li.dataset.limitId, why: 'another limit is hidden or lost its value'}); continue; }
          const bar = li.querySelector('[class*="__limitBar___"]');
          if (!empty && (!bar || !shown(bar))) fails.push({who, limit: li.dataset.limitId, why: 'another limit lost its bar'});
          const small = li.querySelector('small');
          if (small && !shown(small)) fails.push({who, limit: li.dataset.limitId, why: 'another limit lost its reset'});
          if (li.dataset.low === 'true' && !li.querySelector('[class*="__limitWarning___"]')) fails.push({who, limit: li.dataset.limitId, why: 'a low limit lost its warning'});
        }
      }
      if (!others) fails.push({why: 'no other limit to measure'});
      return fails;
    }"""
    out = []
    was_open = await page.locator("article details[open]").count()
    await h_expand_all(page)
    out += [dict(view="weekly", **f) for f in await page.evaluate(measure, "weekly")]
    await switch_view(page, "5-hour")
    await page.locator("article").first.wait_for()
    await page.wait_for_timeout(400)
    await h_expand_all(page)
    out += [dict(view="five-hour", **f) for f in await page.evaluate(measure, "five-hour")]
    await switch_view(page, "Weekly")
    await page.locator("article").first.wait_for()
    await page.wait_for_timeout(400)
    await h_expand_all(page)
    if not was_open:
        for _ in range(await page.get_by_role("button", name="Collapse all").count()):
            await page.get_by_role("button", name="Collapse all").first.click()
    return out


async def check_panel_order(page, state, width):
    """H3: from the limits down an opened row reads Manual resets (full row), Usage, Billing at 900px and below,
    in the visual and the DOM order; at 1100 and 1280 Usage is left of Billing, which is left of Manual resets."""
    if state != "expanded" or width not in (390, 820, 1100, 1280):
        return []
    return await page.evaluate("(wide) => {" + H_PRELUDE + r"""
      const fails = [], rows = [...document.querySelectorAll('article details[open]')];
      if (!rows.length) return [{why: 'no open row to measure'}];
      for (const row of rows) {
        const who = row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent;
        const facts = row.querySelector('[class*="__accountFacts___"]'), sections = [...facts.querySelectorAll('section')];
        const find = re => sections.find(s => re.test(s.querySelector('h4')?.textContent || '')), usage = find(/^Usage$/), billing = find(/^Billing$/), resets = sections.find(s => s.dataset.tone === 'accent');
        if (!usage || !billing || !resets || sections.length !== 3) { fails.push({who, why: 'row does not hold exactly Usage, Billing and Manual resets', found: sections.length}); continue; }
        if (facts.querySelectorAll('[data-tone="accent"]').length !== 1) fails.push({who, why: 'not exactly one reset section'});
        const r = e => e.getBoundingClientRect(), limits = row.querySelector('summary > ul[aria-label="Limits"]'), cs = getComputedStyle(facts);
        if (!wide) {
          const dom = sections.map(s => s === resets ? 'resets' : s === usage ? 'usage' : 'billing').join(',');
          if (dom !== 'resets,usage,billing') fails.push({who, why: 'DOM order is ' + dom});
          const lim = [...limits.children].filter(shown), last = lim[lim.length - 1] || limits;
          if (r(resets).top < r(last).bottom - 1) fails.push({who, why: 'Manual resets starts above the limits end'});
          if (r(usage).top < r(resets).bottom - 1 || r(billing).top < r(usage).bottom - 1) fails.push({who, why: 'visual order is not resets, usage, billing', tops: [resets, usage, billing].map(e => Math.round(r(e).top))});
          const inner = r(facts).width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          if (Math.abs(r(resets).width - inner) > 2) fails.push({who, why: `Manual resets spans ${r(resets).width.toFixed(0)} of the ${inner.toFixed(0)}px row`});
        } else {
          if (!(r(usage).left < r(billing).left - 4 && r(billing).left < r(resets).left - 4)) fails.push({who, why: 'Usage is not left of Billing, left of Manual resets', lefts: [usage, billing, resets].map(e => Math.round(r(e).left))});
          if (r(usage).right > r(billing).left + 1 || r(billing).right > r(resets).left + 1) fails.push({who, why: 'the three panels overlap'});
        }
      }
      return fails;
    }""", width >= 901)


H_LOADED_ROWS = dict(utility='[class*="__privacy___"]', tabs='[class*="__providerBar___"]', date='[class*="__dateNavigation___"]',
                     options='button[aria-controls="pool-view-options"]', card='section[class*="__combined___"]')


async def check_skeleton_shape(browser, url, page, name, state, width):
    """H4: at 390 the loading skeleton mirrors the loaded structure (utility row, tabs, date, Options, Combined card
    with a heading+toggle row and a select row, provider cards with a title/count/chip row and a pill row) and
    its row tops and first card top are within 4px of a loaded page's at 390x844. Placeholders are visible, inert
    and aria-hidden. Opens its own second page in state ready."""
    if name != "loading-narrow":
        return []
    fails = []
    rows = await page.evaluate("""() => {
      const top = e => e.getBoundingClientRect().top, h = e => e.getBoundingClientRect().height;
      const rows = Object.fromEntries([...document.querySelectorAll('[data-skeleton-row]')].map(e => [e.dataset.skeletonRow, {top: top(e), height: h(e),
        visible: h(e) > 0 && e.checkVisibility({checkVisibilityCSS: true}), hidden: !!e.closest('[aria-hidden="true"]'), inert: !!e.closest('[inert]')}]));
      const card = document.querySelector('[data-skeleton-row="card"]');
      const part = (root, sel) => root.querySelector('[class*="__' + sel + '___"]');
      const provider = [...document.querySelectorAll('[class*="__loadingIdentity___"]')].map(i => ({
        title: top(part(i, 'loadingTitle')), count: top(part(i, 'loadingCount')), chip: top(part(i, 'loadingChip')), pills: top(part(i, 'loadingPills')),
        sizes: [...i.querySelectorAll('[class*="__loadingCount___"], [class*="__loadingChip___"], [class*="__loadingPill___"]')].map(h), inert: !!i.closest('[inert]'), hidden: !!i.closest('[aria-hidden="true"]')}));
      return {rows, provider, combined: card && {heading: top(card.querySelector('h2')) + h(card.querySelector('h2')) / 2, toggle: top(part(card, 'loadingToggle')) + h(part(card, 'loadingToggle')) / 2, select: top(part(card, 'loadingSelect')),
        toggleH: h(part(card, 'loadingToggle')), selectH: h(part(card, 'loadingSelect'))}};
    }""")
    for key in H_LOADED_ROWS:
        if key not in rows["rows"]:
            fails.append(dict(why=f"skeleton has no {key} row"))
        elif not rows["rows"][key]["visible"] or rows["rows"][key]["height"] < 16:
            fails.append(dict(why=f"skeleton {key} row is not visible", row=rows["rows"][key]))
        elif key != "card" and not (rows["rows"][key]["hidden"] and rows["rows"][key]["inert"]):
            fails.append(dict(why=f"skeleton {key} row is not aria-hidden and inert", row=rows["rows"][key]))
    combined = rows["combined"]
    if not combined or abs(combined["heading"] - combined["toggle"]) > 4 or combined["select"] < combined["toggle"] + combined["toggleH"] / 2 - 1:
        fails.append(dict(why="Combined skeleton lacks a heading+toggle row with a select row below", combined=combined))
    if len(rows["provider"]) != 2:
        fails.append(dict(why="expected two provider skeletons", found=len(rows["provider"])))
    for p in rows["provider"]:
        if max(p["title"], p["count"], p["chip"]) - min(p["title"], p["count"], p["chip"]) > 4 or p["pills"] < p["title"] + 20 or min(p["sizes"]) < 20 or not (p["inert"] and p["hidden"]):
            fails.append(dict(why="provider skeleton lacks a title/count/chip row and a pill row, or is not inert and aria-hidden", provider=p))
    loaded, context = await h_open_ready_page(browser, url, 390, 844)
    try:
        tops = await loaded.evaluate("(map) => Object.fromEntries(Object.entries(map).map(([k, s]) => [k, document.querySelector(s)?.getBoundingClientRect().top ?? null]))", H_LOADED_ROWS)
    finally:
        await context.close()
    for key, top in tops.items():
        if top is None:
            fails.append(dict(why=f"loaded page has no {key} row to compare"))
        elif key in rows["rows"] and abs(rows["rows"][key]["top"] - top) > 4:
            fails.append(dict(why=f"skeleton {key} top {rows['rows'][key]['top']:.0f} vs loaded {top:.0f}"))
    return fails


async def h_open_ready_page(browser, url, width, height):
    """A second page in state ready (the case page keeps its own state). Returns (page, context)."""
    context, page = await open_fixture_page(browser, url, "ready", width, "en", None, height)
    return page, context


# A checks (Accounts header). Each has its own JSON key, registered in A_KEYS (one per line) for the summary and the
# exit gate. A check that finds nothing to measure fails. ru and vi open a fresh page of their own.
A_KEYS = (
    "summaryFactFailures",
    "statusChipFailures",
)
# "ready" is the laptop case (and narrow-320, where a pair is most likely to overflow).
A_SUMMARY_CASES = ("laptop", "narrow-320", "partial", "stale", "no-limit", "many", "many-narrow", "stale-narrow")
A_SUMMARY_LANG_CASES = ("partial", "no-limit", "stale-narrow", "many", "many-narrow")
A_CHIP_CASES = ("laptop", "narrow", "many", "stale-minimized")
A_CHIP_LANG_CASES = ("many",)


def a_expected_facts(state, provider):
    """The summary pairs a provider card must show today (English), derived from the fixture, not from the page."""
    pool = next(p for p in fixture(state)["pools"] if p["provider"] == provider)
    five_hour = state == "no-limit"
    available = sum(a["resets"]["available"] for a in pool["accounts"] if a["resets"])
    usable = sum(a["resets"]["usable"] for a in pool["accounts"] if a["resets"])
    stale = sum(a["status"] == "stale" for a in pool["accounts"])
    no_limit = sum(bool(a.get("noFiveHourLimit")) for a in pool["accounts"]) if five_hour else 0
    facts = []
    if available:
        facts.append(("Manual resets", str(available)))
        if usable:
            facts.append(("Usable now", str(usable)))
    if pool["loadedCount"] != pool["accountCount"] or pool["eligibleCount"] != pool["accountCount"]:
        if stale:
            facts += [("Current", str(pool["loadedCount"])), ("Stale", str(stale))]
        elif no_limit:
            facts.append(("5-hour limit", f"{pool['eligibleCount']} of {pool['accountCount']}"))
            if pool["loadedCount"] < pool["eligibleCount"]:
                facts.append(("Reporting", f"{pool['loadedCount']} of {pool['eligibleCount']}"))
        else:
            facts.append(("Reporting", f"{pool['loadedCount']} of {pool['eligibleCount']}"))
    return facts


A_SUMMARY_JS = "() => {" + C3_HELPERS + r"""
  const out=[],cards=[];
  for(const article of document.querySelectorAll('article')){
    const provider=/__codex___/.test(article.className)?'codex':'claude',section=article.querySelector('section[class*="__accounts___"]');
    const groups=[...section.querySelectorAll('[class*="__accountSummary___"]')].filter(shown),facts=[];
    if(groups.length>1)out.push({provider,why:groups.length+' summary groups; the facts share one wrapping group'});
    for(const group of groups){
      const items=[...group.children],gap=parseFloat(getComputedStyle(group).columnGap)||0,box=group.getBoundingClientRect();
      const rects=items.map(e=>e.getBoundingClientRect()),sum=rects.reduce((a,b)=>a+b.width,0)+gap*Math.max(0,items.length-1);
      for(const [i,item] of items.entries()){
        const label=item.querySelector('[class*="__summaryLabel___"]'),value=item.querySelector('[class*="__summaryValue___"]');
        if(!label||!value||!label.textContent.trim()||!value.textContent.trim()){out.push({provider,why:'a summary item lacks a label or a value element'});continue;}
        facts.push([label.textContent.trim(),value.textContent.trim()]);
        const vs=getComputedStyle(value),fs=parseFloat(getComputedStyle(item).fontSize),r=rects[i];
        if(vs.fontWeight!=='500'||!/tabular-nums/.test(vs.fontVariantNumeric))out.push({provider,label:label.textContent,why:'value is not weight 500 with tabular figures',weight:vs.fontWeight,numeric:vs.fontVariantNumeric});
        // Stacked pair: the label sits directly above its value, both start at the pair's left edge, and neither wraps.
        const lr=label.getBoundingClientRect(),vr=value.getBoundingClientRect(),ls=getComputedStyle(label);
        if(vr.top<lr.bottom-1||vr.top-lr.bottom>8||Math.abs(lr.left-vr.left)>1)out.push({provider,label:label.textContent,why:'the label is not directly above its value',labelBottom:Math.round(lr.bottom),valueTop:Math.round(vr.top)});
        if(lr.height>parseFloat(ls.fontSize)*1.9||vr.height>parseFloat(vs.fontSize)*1.9)out.push({provider,label:label.textContent,why:'a label or value wraps inside its pair'});
        if(parseFloat(vs.fontSize)>=15||parseFloat(vs.fontSize)<=parseFloat(ls.fontSize))out.push({provider,label:label.textContent,why:'the pair is not one step below the Now and Forecast facts (value under 15px, label smaller than its value)',value:vs.fontSize,label_:ls.fontSize});
        if(r.right>box.right+0.5||r.left<box.left-0.5||r.right>innerWidth+0.5)out.push({provider,label:label.textContent,why:'a pair overflows its container',right:Math.round(r.right),container:Math.round(box.right),viewport:innerWidth});
      }
      const tops=rects.map(r=>Math.round(r.top));
      if(sum<=box.width+0.5&&Math.max(...tops)-Math.min(...tops)>1)out.push({provider,why:'the items fit on one line ('+Math.round(sum)+' of '+Math.round(box.width)+'px) but sit on different tops',tops});
    }
    cards.push({provider,facts});
  }
  return {out,cards};
}"""


async def a_summary_pass(page, state, lng, out):
    got = await page.evaluate(A_SUMMARY_JS)
    out += [dict(f, lng=lng) for f in got["out"]]
    if not got["cards"]:
        out.append(dict(lng=lng, why="no provider card to measure"))
    measured = 0
    for card in got["cards"]:
        want = a_expected_facts(state, card["provider"])
        have = card["facts"]
        measured += len(have)
        if lng == "en" and have != [list(w) for w in want]:
            out.append(dict(provider=card["provider"], lng=lng, why=f"summary reads {have}, expected {want}"))
        elif lng != "en":
            numbers = lambda pairs: [re.findall(r"\d+", v) for _, v in pairs]
            if numbers(have) != numbers(want) or any(not label or label == w[0] for (label, _), w in zip(have, want)):
                out.append(dict(provider=card["provider"], lng=lng, why=f"summary {have} should have the numbers of {want} under translated labels"))
    if not measured:
        out.append(dict(lng=lng, why="no summary item to measure"))


async def check_summary_facts(page, context, url, route_api, name, state):
    """A3: every summary item is a label/value pair in one shared wrapping group; values keep the Manual resets style;
    the facts are today's (Manual resets, Usable now, Reporting, Current, Stale, 5-hour limit) with the fixture's
    numbers; a pair never breaks inside or overflows its container; items that fit one line share a top."""
    if name not in A_SUMMARY_CASES:
        return []
    out = []
    await a_summary_pass(page, state, "en", out)
    if name in A_SUMMARY_LANG_CASES:
        for lng in R_LANGS:
            fresh = await r_page(context, url, route_api, "", lng)
            try:
                if state == "no-limit":
                    await fresh.evaluate("location.hash = '/quota?window=five-hour'")
                    await fresh.wait_for_timeout(400)
                await a_summary_pass(fresh, state, lng, out)
            finally:
                await fresh.close()
    return out


# H1-C checks (caption type, search label, rate-view balance). Each has its own JSON key, registered in H1C_KEYS
# for the summary and the exit gate. A check that finds nothing to measure where it applies fails.
H1C_KEYS = ("captionFailures", "searchLabelFailures", "rateBalanceFailures")
H1C_CAPTION_CASES = ("wide", "laptop", "narrow", "expanded", "drain", "expanded-1100", "laptop-1100")
H1C_CAPTION_JS = "() => {" + C3_HELPERS + r"""
  const picks = [
    ['axis tick', '[class*="__grid___"] text'], ['axis unit', 'text[class*="__axisUnit___"]'],
    ['legend', '[class*="__legend___"]'], ['latest reading', '[class*="__chartReadout___"]'],
    ['resets line', 'ul[aria-label="Limits"] li > small'], ['counts toward total', '[class*="__accountHead___"] small'],
  ];
  const out = [];
  for (const [cat, sel] of picks) for (const e of document.querySelectorAll(sel)) {
    if (!shown(e)) continue;
    // An SVG label's CSS size is in user units; the chart's viewBox is its CSS width, so the scale is 1, but measure it anyway.
    const scale = e instanceof SVGGraphicsElement ? (e.getScreenCTM()?.a || 1) : 1;
    const boxes = [], w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      if (!w.currentNode.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(w.currentNode);
      for (const b of r.getClientRects()) if (b.width > 2 && b.height > 2) boxes.push({x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height});
    }
    out.push({cat, text: e.textContent.trim().slice(0, 40), size: parseFloat(getComputedStyle(e).fontSize) * scale, boxes});
  }
  return out;
}"""


async def check_captions(page, name, state, width):
    """H1-C2: the small grey captions (axis ticks and unit, legends, "Latest reading", a limit's "Resets" line, "counts
    toward total") are at least 13px and read at 5.5:1 or better against what they sit on, measured from the pixels."""
    if name not in H1C_CAPTION_CASES:
        return []
    found = await page.evaluate(H1C_CAPTION_JS)
    shot = Image.open(io.BytesIO(await page.screenshot(full_page=True, animations="disabled"))).convert("RGB")
    out = []
    need = ["axis tick", "axis unit", "legend", "latest reading"]
    if width >= 901:
        need.append("counts toward total")
    if state == "expanded":
        need.append("resets line")
    # Raising the size must not make one caption run into another of its kind (a Resets line into the next column's).
    for i, a in enumerate(found):
        for b in found[i + 1:]:
            if a["cat"] != b["cat"]:
                continue
            for p in a["boxes"]:
                for q in b["boxes"]:
                    dx = min(p["x"] + p["w"], q["x"] + q["w"]) - max(p["x"], q["x"])
                    dy = min(p["y"] + p["h"], q["y"] + q["h"]) - max(p["y"], q["y"])
                    if dx > 1 and dy > 2:
                        out.append(dict(cat=a["cat"], text=a["text"], why=f"overlaps another {a['cat']} ({b['text']!r}) by {dx:.0f}px"))
    for cat in need:
        if not any(f["cat"] == cat for f in found):
            out.append(dict(why=f"no {cat} to measure"))
    for f in found:
        if f["size"] < 12.99:
            out.append(dict(cat=f["cat"], text=f["text"], why=f"font size {f['size']:.1f}px, under 13px"))
        worst = None
        for box in f["boxes"]:
            colours = pixels(shot, box)
            if not colours:
                continue
            bg = colours.most_common(1)[0][0]
            fg = max(colours, key=lambda c: ratio(c, bg))
            worst = min(worst, ratio(fg, bg)) if worst is not None else ratio(fg, bg)
        if worst is None:
            out.append(dict(cat=f["cat"], text=f["text"], why="no painted pixels to measure"))
        elif worst < 5.5:
            out.append(dict(cat=f["cat"], text=f["text"], why=f"contrast {worst:.2f}:1, under 5.5:1"))
    return out


async def check_search_label(page, name, state):
    """H1-C3: with text typed, the roster search field still has a visible label element associated with it (the
    field's <label>), in view, beside the typed text rather than over it, and the field is named by it."""
    if name not in ("many", "many-search-narrow"):
        return []
    search = page.locator('article input[type="search"]').first
    if not await search.count():
        return [dict(why="no roster search field to measure")]
    await search.scroll_into_view_if_needed()
    await search.fill("gra")
    got = await page.evaluate("""() => {
      const input = document.querySelector('article input[type="search"]'), label = input.labels[0], out = [];
      if (!input.value) out.push({why: 'no text typed'});
      const span = label && label.querySelector('span');
      if (!span || !span.textContent.trim()) return out.concat({why: 'the field has no visible label text'});
      const s = span.getBoundingClientRect(), i = input.getBoundingClientRect(), v = {w: innerWidth, h: innerHeight};
      if (!span.checkVisibility({checkVisibilityCSS: true}) || s.width < 1) out.push({why: 'the label is not visible'});
      if (s.left < 0 || s.right > v.w || s.top < 0 || s.bottom > v.h) out.push({why: 'the label is not in view', rect: [s.left, s.top, s.right, s.bottom].map(Math.round)});
      if (s.right > i.left + 1) out.push({why: 'the label overlaps the typed text'});
      return out.concat({text: span.textContent.trim(), ok: true});
    }""")
    out = [f for f in got if not f.get("ok")]
    label = next((f["text"] for f in got if f.get("ok")), None)
    if label and not await page.get_by_role("searchbox", name=label, exact=True).count():
        out.append(dict(why=f"the field is not named by its visible label {label!r}"))
    await search.fill("")
    return out


async def check_rate_balance(page, name, state):
    """H1-C4: a rate view's balance is the headline's context line (no "Now" heading over a single fact): it sits under
    the rate, its number has the value style, and its unit has the same muted style as "points/h"."""
    if state not in ("drain", "burn"):
        return []
    return await page.evaluate("() => {" + C1_PRELUDE + r"""
      const out = []; let measured = 0;
      if ([...document.querySelectorAll('article [class*="__statsHeading___"]')].some(h => shown(h) && h.textContent.trim() === 'Now')) out.push({why: 'a Now heading still stands over the single balance fact'});
      const probe = parent => { const p = document.createElement('span'); p.style.cssText = 'display:inline-block;width:0;height:0'; parent.appendChild(p); const y = p.getBoundingClientRect().bottom; p.remove(); return y; };
      for (const card of document.querySelectorAll('article')) {
        const who = card.querySelector('h2')?.textContent, h = card.querySelector('[class*="__headline___"]'), line = h && h.querySelector('[class*="__headlineBalance___"]');
        if (!line) { out.push({who, why: 'no balance line under the headline'}); continue; }
        const strong = h.querySelector('strong'), unit = strong.querySelector('small'), b = line.querySelector('b'), small = line.querySelector('small');
        if (!b || !small || !unit) { out.push({who, why: 'balance line lacks its number or unit, or the headline its unit'}); continue; }
        measured++;
        if (line.getBoundingClientRect().top < strong.getBoundingClientRect().bottom - 1) out.push({who, why: 'balance line is not under the headline number'});
        const us = getComputedStyle(unit), ss = getComputedStyle(small), bs = getComputedStyle(b), ns = getComputedStyle(strong);
        if (us.color !== ss.color || us.fontWeight !== ss.fontWeight || us.fontSize !== ss.fontSize) out.push({who, why: 'the balance unit style differs from "points/h"', headline: [us.color, us.fontWeight, us.fontSize], balance: [ss.color, ss.fontWeight, ss.fontSize]});
        if (parseInt(bs.fontWeight) < 500 || bs.color !== ns.color || !/tabular-nums/.test(bs.fontVariantNumeric)) out.push({who, why: 'the balance number is not in the value style', weight: bs.fontWeight, color: bs.color});
        const drift = Math.abs(probe(b) - probe(small));
        if (drift > 2) out.push({who, why: `balance unit baseline ${drift.toFixed(1)}px off its number's`});
      }
      if (!measured) out.push({why: 'no rate headline with a balance line to measure'});
      return out;
    }""")


A_CHIP_JS = "(idxs) => {" + C3_HELPERS + r"""
  const parse=c=>{const m=(c.match(/[\d.]+(?:e-?\d+)?/g)||[]).map(Number);if(!m.length)return [0,0,0,0];
    const v=m.slice(0,3).map(x=>c.startsWith('color(')?x*255:x);return [...v,m.length>3?m[3]:1];};
  const over=(top,under)=>{const a=top[3];return [0,1,2].map(i=>top[i]*a+under[i]*(1-a)).concat(1);};
  const lum=c=>{const l=c.slice(0,3).map(v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*l[0]+0.7152*l[1]+0.0722*l[2];};
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
  // The surface under the chip: every ancestor's background painted from the page down (the card's gradient is ignored).
  const surface=el=>{const chain=[];for(let n=el.parentElement;n;n=n.parentElement)chain.unshift(n);
    return chain.reduce((under,n)=>over(parse(getComputedStyle(n).backgroundColor),under),[0,0,0,1]);};
  const chips=[...document.querySelectorAll('article [class*="__accountResetMarker___"]')];
  return (idxs||chips.map((_,i)=>i)).map(i=>{
    const chip=chips[i],s=getComputedStyle(chip),row=surface(chip),fill=over(parse(s.backgroundColor),row),ink=parse(s.color);
    const sides=['Top','Right','Bottom','Left'].map(x=>parseFloat(s['border'+x+'Width']));
    return {i,text:chip.textContent.trim(),usable:chip.hasAttribute('data-usable'),shown:chip.checkVisibility({checkVisibilityCSS:true}),
      provider:/__codex___/.test(chip.closest('article').className)?'codex':'claude',
      border:Math.max(...sides),radius:parseFloat(s.borderTopLeftRadius),size:parseFloat(s.fontSize),
      fillRatio:ratio(fill,row),textRatio:ratio(ink,fill),ink:s.color,open:chip.closest('details').open};
  });
}"""


async def a_chip_pass(page, lng, out, compare=True):
    chips = await page.evaluate(A_CHIP_JS, None)
    if not chips:
        out.append(dict(lng=lng, why="no reset chip to measure"))
        return
    # One chip per provider and variant stands for the hover and open rows.
    probes = {}
    for c in chips:
        probes.setdefault((c["provider"], c["usable"]), c)
    states = {"closed": chips}
    for label in ("hover", "open"):
        states[label] = []
        for c in probes.values():
            row = page.locator("article [class*='__accountResetMarker___']").nth(c["i"]).locator("xpath=ancestor::details[1]")
            if label == "hover":
                await row.locator("summary").hover()
            else:
                await page.mouse.move(0, 0)
                await row.evaluate("r => { r.open = true; }")
            states[label] += await page.evaluate(A_CHIP_JS, [c["i"]])
            if label == "open":
                await row.evaluate("r => { r.open = false; }")
        await page.mouse.move(0, 0)
    for label, readings in states.items():
        for c in readings:
            where = dict(lng=lng, state=label, chip=c["text"])
            if c["border"] != 0:
                out.append(dict(where, why=f"border is {c['border']}px"))
            if not c["radius"] < 999:
                out.append(dict(where, why=f"radius is {c['radius']}px"))
            if c["size"] < 13:
                out.append(dict(where, why=f"text is {c['size']}px"))
            if c["fillRatio"] < 1.15:
                out.append(dict(where, why=f"chip vs row contrast {c['fillRatio']:.2f}"))
            if c["textRatio"] < 4.5:
                out.append(dict(where, why=f"text contrast {c['textRatio']:.2f}"))
            if label == "closed" and not c["shown"]:
                out.append(dict(where, why="a closed row's chip is not visible"))
    inks = {usable: {c["ink"] for c in chips if c["usable"] == usable} for usable in (True, False)}
    if not compare:
        return
    if not inks[True] or not inks[False]:
        out.append(dict(lng=lng, why="needs both a usable and a non-usable chip to compare", usable=sorted(inks[True]), plain=sorted(inks[False])))
    elif inks[True] & inks[False]:
        out.append(dict(lng=lng, why="usable and non-usable chips share a text colour", colours=sorted(inks[True] & inks[False])))


async def check_status_chip(page, context, url, route_api, name, state):
    """A4: the "Resets N" and "Resets N · N usable" chips in rows have no border, a subtle fill (at least 1.15:1 on the
    closed, hovered and open row), the small radius, text of 13px or more at 4.5:1 on that fill, and a usable chip's
    text colour differs from a plain one's. ru and vi repeat it on `many`."""
    if name not in A_CHIP_CASES:
        return []
    out = []
    # A long roster shows 25 rows, and the Codex row that has a usable reset sorts later: the `many` passes
    # (in every language) open all rows on a fresh page, so both chip variants are on screen to compare.
    paged = name in A_CHIP_LANG_CASES
    await a_chip_pass(page, "en", out, compare=not paged)
    for lng in (("en", *R_LANGS) if paged else ()):
        fresh = await r_page(context, url, route_api, "", lng)
        try:
            more = fresh.locator('article [class*="__rosterFooter___"] button')
            while await more.count():
                await more.first.click()
            await a_chip_pass(fresh, lng, out)
        finally:
            await fresh.close()
    return out
# B phone checks (round b1): account rows at 900px and below, and the phone provider header's chip line. Each has its
# own JSON key, registered in B_KEYS for the summary and the exit gate. A check that finds nothing to measure fails.
B_KEYS = (
    "phoneRowBlockFailures",
    "phoneHeaderConsistencyFailures",
    "phoneTrackFailures",
    # H1-P: the whole row header as one toggle, the once-per-card "counts toward total" line, the stacked Forecast facts.
    "phoneToggleFailures",
    "phoneCountsNoteFailures",
    "phoneForecastStackFailures",
)
# case -> views measured. no-limit-narrow is a 5-hour page (the Ultra account has no 5-hour limit).
B_ROW_VIEWS = {
    "narrow": ("weekly", "five-hour"), "narrow-320": ("weekly", "five-hour"), "tablet": ("weekly", "five-hour"),
    "many-narrow": ("weekly", "five-hour"), "partial-narrow": ("weekly", "five-hour"), "stale-narrow": ("weekly", "five-hour"),
    "long-narrow": ("weekly", "five-hour"), "no-limit-narrow": ("five-hour",),
}
# (case, view) -> the exception that page must show at least once, so a check can't pass by measuring none of it.
B_ROW_EXPECT = {("partial-narrow", "weekly"): "unavailable", ("long-narrow", "weekly"): "unavailable",
                ("no-limit-narrow", "five-hour"): "missing", ("stale-narrow", "weekly"): "stale", ("stale-narrow", "five-hour"): "stale"}
B_HEADER_CASES = ("narrow", "narrow-320", "many-narrow", "partial-narrow", "stale-narrow", "collecting-narrow")
B_ROW_JS = "(args) => { const [view, isOpen, width] = args;" + H_PRELUDE + r"""
  const fails = [], stats = {rows: 0, unavailable: 0, missing: 0, stale: 0};
  const win = view === 'five-hour' ? '5-hour' : 'Weekly', pct = /\d+(\.\d+)?%/;
  const smalls = [];
  for (const row of [...document.querySelectorAll('article details')].filter(shown)) {
    const article = row.closest('article'), active = activeId(article, view), summary = row.querySelector(':scope > summary');
    const who = (row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent || '?') + ' / ' + view + (isOpen ? ' open' : ' closed');
    const list = summary.querySelector(':scope > ul[aria-label="Limits"]'), r = e => e.getBoundingClientRect();
    const items = list ? [...list.children].filter(shown) : [];
    stats.rows++;
    // The header keeps the chevron, name, chip and plan: no figure.
    for (const c of summary.children) if (c !== list && shown(c) && pct.test(c.textContent)) fails.push({who, why: 'the row header shows a percentage', text: c.textContent.trim().slice(0, 40)});
    const activeItem = items.find(li => li.dataset.limitId === active);
    if (!activeItem) { fails.push({who, why: 'no block for the active window'}); continue; }
    const byTop = [...items].sort((a, b) => r(a).top - r(b).top);
    const label = li => li.querySelector(':scope > span:first-child'), value = li => li.querySelector(':scope > strong, :scope > em'), bar = li => li.querySelector(':scope > [class*="__limitBar___"]');
    if (byTop[0] !== activeItem) fails.push({who, why: 'the active window is not the first block'});
    if (label(byTop[0]).textContent.trim() !== win + ' remaining') fails.push({who, why: 'the first block reads "' + label(byTop[0]).textContent.trim() + '"'});
    for (const li of items) {
      const l = r(label(li)), v = r(value(li)), b = bar(li) && shown(bar(li)) ? bar(li) : null, id = li.dataset.limitId, at = {who, limit: id};
      if (v.left < l.left + 1) fails.push({...at, why: 'the value is not right of its label'});
      if (v.top > l.bottom - 2) fails.push({...at, why: 'the value is on a line below its label'});
      if (b && r(b).top < Math.max(l.bottom, v.bottom) - 1) fails.push({...at, why: 'the bar is not under its label and value'});
      // An "Unavailable" value keeps the wide table's amber warning colour (the status line's, hidden here but still
      // computed; a probe of the same token when the row has none) and its aria-hidden warning icon.
      const uw = li.querySelector('[class*="__unavailableWord___"]');
      if (uw && shown(uw)) {
        const ref = row.matches('[data-status="error"], [data-status="missing-window"]') ? getComputedStyle(summary.querySelector('[class*="__accountStatus___"]')).color : (() => { const p = document.createElement('i'); p.style.color = 'var(--warning-text)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })();
        if (getComputedStyle(uw).color !== ref) fails.push({...at, why: 'the Unavailable value is not in the warning colour', colour: getComputedStyle(uw).color, warning: ref});
        const icon = uw.querySelector('svg');
        if (!icon || icon.getAttribute('aria-hidden') !== 'true' || !shown(icon)) fails.push({...at, why: 'the Unavailable value lacks its aria-hidden warning icon'});
      }
      const small = li.querySelector(':scope > small');
      if (small && shown(small)) {
        if (!b || b.nextElementSibling !== small) fails.push({...at, why: 'the reset line is not the next sibling of its own bar'});
        else if (r(small).top < r(b).bottom - 1 || r(small).top - r(b).bottom > 12) fails.push({...at, why: 'the reset line is not directly under its bar'});
        smalls.push({who, limit: id, size: getComputedStyle(small).fontSize, color: getComputedStyle(small).color});
      } else if (small && isOpen) fails.push({...at, why: 'an opened row hides a limit\'s reset line'});
    }
    // The active window's exceptions keep their reason and never invent a value or a filled bar.
    // The active window keeps weight 600 on its label and value; no other block's value does.
    const weight = e => parseInt(getComputedStyle(e).fontWeight, 10);
    if (weight(label(activeItem)) < 600 || weight(value(activeItem)) < 600) fails.push({who, why: 'the active window lacks weight 600', label: weight(label(activeItem)), value: weight(value(activeItem))});
    for (const li of items) if (li !== activeItem && weight(value(li)) >= 600) fails.push({who, limit: li.dataset.limitId, why: 'a non-active limit value is bold', weight: weight(value(li))});
    const ev = value(activeItem), eb = bar(activeItem), filled = eb && eb.querySelector(':scope > span');
    const status = summary.querySelector('[class*="__accountStatus___"]');
    if (activeItem.dataset.missing) {
      stats.missing++;
      if (!ev.textContent.trim() || pct.test(ev.textContent) || (eb && shown(eb))) fails.push({who, why: 'a missing or unlimited window shows no plain reason, or a percentage or bar', text: ev.textContent.trim()});
    } else if (activeItem.querySelector('[class*="__unavailableWord___"]') && shown(activeItem.querySelector('[class*="__unavailableWord___"]'))) {
      stats.unavailable++;
      if (ev.textContent.replace('—', '').trim() !== 'Unavailable') fails.push({who, why: 'the unavailable block reads "' + ev.textContent.trim() + '"'});
      if (!eb || !shown(eb) || filled || getComputedStyle(eb).borderTopStyle !== 'dashed') fails.push({who, why: 'the unavailable block lacks its empty dashed track'});
      if (status && shown(status) && /unavailable/i.test(status.textContent)) fails.push({who, why: 'a separate "quota unavailable" line remains', text: status.textContent.trim()});
    } else if (!pct.test(ev.textContent) || !eb || !shown(eb) || !(filled && r(filled).width > 0)) fails.push({who, why: 'a numeric window lacks its value or filled bar', text: ev.textContent.trim()});
    // Stale: the line belongs to the account, so it sits directly under the name and plan line and above the first block.
    if (row.dataset.status === 'stale') {
      stats.stale++;
      const plan = summary.querySelector('[class*="__accountPlan___"]');
      if (!status || !shown(status)) fails.push({who, why: 'a stale row shows no status line'});
      else if (!plan) fails.push({who, why: 'a stale row has no plan line to sit under'});
      else {
        const gap = r(status).top - r(plan).bottom;
        if (gap < -1) fails.push({who, why: 'the stale line is not below the plan line'});
        if (gap > 12) fails.push({who, why: `the stale line is ${gap.toFixed(0)}px below the plan line, not directly under it`});
        if (r(status).bottom > r(byTop[0]).top + 1) fails.push({who, why: 'the stale line is not above the first limit block'});
      }
    }
    // Closed rows at 390 stay compact: 110px with one block, 150px with two or three; a stale line adds its own height.
    if (!isOpen && width === 390) {
      const budget = items.length <= 1 ? 110 : 150, extra = row.dataset.status === 'stale' && status ? r(status).height + 6 : 0, h = r(row).height;
      if (h > budget + extra) fails.push({who, why: `closed row is ${h.toFixed(0)}px tall with ${items.length} block(s) (limit ${budget + extra})`});
    }
  }
  if (!stats.rows) fails.push({why: 'no account row to measure'});
  const first = smalls[0];
  for (const s of smalls) if (s.size !== first.size || s.color !== first.color) fails.push({who: s.who, limit: s.limit, why: `reset line type ${s.size} ${s.color} differs from ${first.size} ${first.color}`});
  if (isOpen && !smalls.length) fails.push({why: 'no reset line to measure in the opened rows'});
  return {fails, stats};
}"""


async def check_phone_row_blocks(page, name, state, width):
    """B1: at 900px and below, closed and opened rows list the active window as the first block ("{window} remaining",
    label left, value right, bar beneath, its reset line the bar's next sibling); the row header carries no
    percentage; reset lines share one style; closed rows stay compact at 390; unavailable, missing and unlimited
    windows and stale lines behave as specified. Weekly and 5-hour views where they exist."""
    views = B_ROW_VIEWS.get(name)
    if not views:
        return []
    labels = {"weekly": "Weekly", "five-hour": "5-hour"}
    start = "five-hour" if state == "no-limit" else "weekly"
    out, seen = [], {}
    for view in views:
        if view != start:
            await switch_view(page, labels[view])
            await page.locator("article").first.wait_for()
            await page.wait_for_timeout(400)
        for opened in (False, True):
            if opened:
                await h_expand_all(page)
            result = await page.evaluate(B_ROW_JS, [view, opened, width])
            out += [dict(view=view, open=opened, **f) for f in result["fails"]]
            for key, n in result["stats"].items():
                seen[(view, key)] = seen.get((view, key), 0) + n
        for _ in range(await page.get_by_role("button", name="Collapse all").count()):
            await page.get_by_role("button", name="Collapse all").first.click()
    for (case, view), kind in B_ROW_EXPECT.items():
        if case == name and view in views and not seen.get((view, kind)):
            out.append(dict(view=view, why=f"no {kind} block to measure in this case"))
    if start != views[-1]:
        await switch_view(page, labels[start])
        await page.locator("article").first.wait_for()
        await page.wait_for_timeout(400)
    return out


P2_TRACK_CASES = ("narrow", "narrow-320", "tablet", "many-narrow", "partial-narrow", "stale-narrow", "collecting-narrow",
                  "burn-narrow", "refresh-pending-narrow")
P2_TRACK_JS = "(isOpen) => {" + C1_PRELUDE + r"""
  const fails = [], pct = /(\d+(?:\.\d+)?)%/;
  let tracks = 0;
  for (const article of document.querySelectorAll('article')) {
    const who = (article.querySelector('h2')?.textContent || '?').trim() + (isOpen ? ' open' : ' closed');
    const seen = [];
    for (const li of article.querySelectorAll('details ul[aria-label="Limits"] > li')) {
      const bar = li.querySelector(':scope > [class*="__limitBar___"]');
      if (!bar || !shown(bar)) continue;
      const r = bar.getBoundingClientRect(), at = {who, limit: li.dataset.limitId, left: +r.left.toFixed(1), right: +r.right.toFixed(1)};
      seen.push(at);
      tracks++;
      // The fill encodes the value: fill width over track width equals the printed percentage, within 2 points.
      const fill = bar.querySelector(':scope > span'), text = li.querySelector(':scope > strong')?.textContent.match(pct);
      if (fill && text) {
        const ratio = fill.getBoundingClientRect().width / r.width * 100;
        if (Math.abs(ratio - parseFloat(text[1])) > 2) fails.push({...at, why: `fill is ${ratio.toFixed(1)}% of its track but the value reads ${text[1]}%`});
      } else if (fill || text) fails.push({...at, why: 'a bar and its value text do not pair up'});
    }
    // Every track in a card shares both edges (1px), whatever its value text, Low word or row.
    if (seen.length) {
      const lefts = seen.map(s => s.left), rights = seen.map(s => s.right);
      if (Math.max(...lefts) - Math.min(...lefts) > 1 || Math.max(...rights) - Math.min(...rights) > 1) fails.push({who, why: 'bar tracks do not share left and right edges', lefts: [...new Set(lefts)], rights: [...new Set(rights)]});
    }
  }
  if (!tracks) fails.push({why: 'no visible limit bar track to measure'});
  return fails;
}"""


async def check_phone_tracks(page, name):
    """P2: at 900px and below, every visible limit bar track in a provider card has the same left and right edges
    (1px), and its fill is the printed value of its width (2 points), in closed and opened rows."""
    if name not in P2_TRACK_CASES:
        return []
    out = []
    for opened in (False, True):
        if opened:
            await h_expand_all(page)
        out += [dict(open=opened, **f) for f in await page.evaluate(P2_TRACK_JS, opened)]
    for _ in range(await page.get_by_role("button", name="Collapse all").count()):
        await page.get_by_role("button", name="Collapse all").first.click()
    return out


P_TOGGLE_CASES = ("narrow", "narrow-320", "details-narrow", "expanded-narrow", "stale-narrow")
P_NOTE_CASES = P_TOGGLE_CASES + ("many-narrow", "tablet", "laptop")
P_FORECAST_CASES = ("narrow", "narrow-320", "tablet", "burn-narrow", "drain-narrow", "partial-narrow", "stale-narrow", "collecting-narrow")
P_TOGGLE_JS = "() => {" + C1_PRELUDE + r"""
  const fails = [], rows = [...document.querySelectorAll('article details')].filter(shown);
  for (const row of rows) {
    const summary = row.querySelector(':scope > summary'), s = summary.getBoundingClientRect(), r = row.getBoundingClientRect();
    const who = row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent || '?';
    if (s.height < 43.5) fails.push({who, why: `the row header toggle is ${s.height.toFixed(1)}px tall`});
    if (s.width < r.width * 0.8) fails.push({who, why: `the row header toggle spans ${s.width.toFixed(0)} of the ${r.width.toFixed(0)}px row`});
    if (summary.getAttribute('aria-expanded') !== String(row.open)) fails.push({who, why: 'aria-expanded does not match the row', attr: summary.getAttribute('aria-expanded'), open: row.open});
    const nested = summary.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"]');
    if (nested.length) fails.push({who, why: 'the row header toggle holds another interactive element', found: [...nested].map(e => e.tagName)});
  }
  return {fails, rows: rows.length};
}"""
P_FOCUS_JS = """(summary) => {
  const s = getComputedStyle(summary);
  return {style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, focused: document.activeElement === summary};
}"""


def lab(rgb):
    """CIE Lab (D65) of an sRGB triple, for the CIE76 colour difference."""
    lin = [((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92 for c in rgb[:3]]
    x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047
    y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


async def header_fill(page, summary):
    """The pixel colour of a row header's own padding (left edge, top), with the pointer parked away from it."""
    from PIL import Image
    import io
    await page.mouse.move(1, 1)
    await page.wait_for_timeout(80)
    await summary.scroll_into_view_if_needed()
    box = await summary.bounding_box()
    shot = await page.screenshot(clip=dict(x=box["x"] + 1, y=box["y"] + 1, width=4, height=2), animations="disabled")
    return Image.open(io.BytesIO(shot)).convert("RGB").getpixel((1, 0))


async def check_phone_toggle(page, name, width):
    """P3: at 900px and below the whole row header is one toggle: at least 44px tall and 80% of the row wide, with
    aria-expanded matching the row, no interactive element inside it, a click on the account name (not the
    chevron) flips it, the open row's header fill differs from the closed one's by dE >= 3, and keyboard focus
    shows a ring. Cases at 390 and 320."""
    if name not in P_TOGGLE_CASES:
        return []
    out = []
    first = await page.evaluate(P_TOGGLE_JS)
    out += first["fails"]
    if not first["rows"]:
        return [dict(why="no account row to measure")]
    row = page.locator("article details").first
    summary = row.locator(":scope > summary")
    before_open = await row.evaluate("d => d.open")
    before_fill = await header_fill(page, summary)
    # Click the name, which is not the chevron: the whole header toggles.
    await row.locator('[class*="__accountText___"]').first.click()
    await page.wait_for_timeout(150)
    after_open = await row.evaluate("d => d.open")
    if after_open == before_open or await summary.get_attribute("aria-expanded") != str(after_open).lower():
        out.append(dict(why="clicking the account name did not flip the row and its aria-expanded", before=before_open, after=after_open))
    after_fill = await header_fill(page, summary)
    open_fill, closed_fill = (after_fill, before_fill) if after_open else (before_fill, after_fill)
    delta = sum((a - b) ** 2 for a, b in zip(lab(open_fill), lab(closed_fill))) ** 0.5
    if delta < 3:
        out.append(dict(why=f"the open row header fill differs from the closed one by dE {delta:.1f}, under 3", open=open_fill, closed=closed_fill))
    await page.keyboard.press("Shift")
    await summary.focus()
    ring = await summary.evaluate(P_FOCUS_JS)
    if not ring["focused"] or ring["style"] == "none" or ring["width"] < 2:
        out.append(dict(why="the row header toggle shows no focus ring", ring=ring))
    await summary.evaluate("s => s.blur()")
    await row.locator('[class*="__accountText___"]').first.click()
    await page.wait_for_timeout(150)
    await page.mouse.move(1, 1)
    return out


async def check_phone_counts_note(page, name, width):
    """P4: at 900px and below each provider card with accounts says once, above its first row, what the bold limit is;
    from 901px that line is hidden because the column header says it."""
    if name not in P_NOTE_CASES:
        return []
    return await page.evaluate("(phone) => {" + C1_PRELUDE + r"""
      const fails = [], articles = [...document.querySelectorAll('article')].filter(a => a.querySelector('details'));
      if (!articles.length) return [{why: 'no card with accounts to measure'}];
      for (const a of articles) {
        const who = a.querySelector('h2')?.textContent, notes = [...a.querySelectorAll('[class*="__phoneCountsNote___"]')], visible = notes.filter(shown);
        if (!notes.length) { fails.push({who, why: 'the card has no counts-toward-total line'}); continue; }
        if (!phone) { if (visible.length) fails.push({who, why: 'the phone counts-toward-total line shows on a wide card'}); continue; }
        if (visible.length !== 1) { fails.push({who, why: `${visible.length} counts-toward-total lines, expected one`}); continue; }
        const note = visible[0], row = [...a.querySelectorAll('details')].filter(shown)[0];
        if (!/total/i.test(note.textContent)) fails.push({who, why: 'the line does not say what counts toward the total', text: note.textContent});
        if (note.getBoundingClientRect().bottom > row.getBoundingClientRect().top + 1) fails.push({who, why: 'the line is not above the first row'});
        if (note.scrollWidth > note.clientWidth + 1) fails.push({who, why: 'the line is clipped'});
      }
      return fails;
    }""", width <= 900)


async def check_phone_forecast_stack(page, name, width):
    """P5: at 900px and below each Forecast fact reads label over value (the value starts below the label and at its
    left edge), and the facts stay inside their card."""
    if name not in P_FORECAST_CASES:
        return []
    return await page.evaluate("() => {" + C1_PRELUDE + r"""
      const fails = [], groups = [...document.querySelectorAll('article [class*="__statsBlock___"] > :last-child dl')].filter(shown);
      if (!groups.length) return [{why: 'no Forecast facts found'}];
      for (const dl of groups) {
        const who = dl.closest('article').querySelector('h2')?.textContent, card = dl.closest('article').getBoundingClientRect(), facts = [...dl.children].filter(shown);
        if (!facts.length) fails.push({who, why: 'the Forecast group holds no fact'});
        for (const f of facts) {
          const dt = f.querySelector('dt').getBoundingClientRect(), dd = f.querySelector('dd').getBoundingClientRect(), label = f.querySelector('dt').textContent;
          if (dd.top < dt.bottom - 1) fails.push({who, label, why: 'the value is not below its label'});
          if (Math.abs(dd.left - dt.left) > 1) fails.push({who, label, why: 'the value does not start at its label\'s left edge'});
          const b = f.getBoundingClientRect();
          if (b.left < card.left || b.right > card.right) fails.push({who, label, why: 'the fact leaves its card'});
        }
      }
      return fails;
    }""")


async def check_header_consistency(browser, url, page, name, state, width):
    """B2: every provider card's chip sits the same distance below its title (within 4px) on a page; fewer than two
    cards fail. Runs on the case's page, and on ru and vi pages for `narrow`."""
    if name not in B_HEADER_CASES:
        return []
    measure = """() => {
      const cards = [...document.querySelectorAll('article')], out = [];
      if (cards.length < 2) return [{why: 'fewer than 2 provider cards (' + cards.length + ')'}];
      const offsets = cards.map(a => ({card: a.querySelector('h2').textContent, d: a.querySelector('[class*="__badge___"]').getBoundingClientRect().top - a.querySelector('h2').getBoundingClientRect().top}));
      if (Math.max(...offsets.map(o => o.d)) - Math.min(...offsets.map(o => o.d)) > 4) out.push({why: 'chip tops differ relative to their titles', offsets: offsets.map(o => [o.card, Math.round(o.d)])});
      return out;
    }"""
    out = [dict(page="case page", **f) for f in await page.evaluate(measure)]
    if name == "narrow":
        for lng in ("ru", "vi"):
            context, sweep = await open_fixture_page(browser, url, state, width, lng, None)
            try:
                out += [dict(page=f"{state}@{width}/{lng}", **f) for f in await sweep.evaluate(measure)]
            finally:
                await context.close()
    return out


# D checks (round d1): the account details panel and the reset dialog. Each has its own JSON key, registered in
# D_KEYS for the summary and the exit gate. A check that finds nothing to measure where it applies fails.
D_KEYS = ("factPanelGapFailures", "predictedEmptyFailures", "resetReasonFailures", "resetDialogFailures")
D_GAP_WIDTHS = (1100, 1280, 1440, 1920)
D_PRELUDE = C1_PRELUDE + r"""
const textRight = el => { // the right edge of the painted text, not of its box
  let right = -Infinity; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.textContent.trim()) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) if (b.width > 0) right = Math.max(right, b.right);
  }
  return right;
};
"""


async def check_fact_panel_gap(page, state, width):
    """D1: in an opened row at 1100/1280/1440/1920 the empty run between the widest content of the last fact
    column and the Manual resets box is at most 96px, every column gap (including the one before Manual resets)
    is equal within 2px, and a drawer wide enough for the panel's own three columns shows three."""
    if state != "expanded" or width not in D_GAP_WIDTHS:
        return []
    return await page.evaluate("() => {" + D_PRELUDE + r"""
      const fails = [], rows = [...document.querySelectorAll('article details[open]')];
      if (!rows.length) return [{why: 'no open row to measure'}];
      for (const row of rows) {
        const who = row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent;
        const facts = row.querySelector('[class*="__accountFacts___"]');
        const accent = facts.querySelector('section[data-tone="accent"]');
        const items = [...facts.querySelectorAll('section')].filter(s => s.dataset.tone !== 'accent').flatMap(s => [...s.querySelectorAll('dl > div')]).filter(shown);
        if (!accent || !shown(accent) || !items.length) { fails.push({who, why: 'no fact column or Manual resets box to measure'}); continue; }
        const columns = [];
        for (const item of items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)) {
          const left = item.getBoundingClientRect().left, last = columns[columns.length - 1];
          if (last && Math.abs(last.left - left) < 3) last.items.push(item); else columns.push({left, items: [item]});
        }
        const panelWidth = facts.firstElementChild.getBoundingClientRect().width;
        if (panelWidth >= 1100 && columns.length !== 3) fails.push({who, why: `a ${panelWidth.toFixed(0)}px panel shows ${columns.length} fact columns, expected 3`});
        if (columns.length < 2) fails.push({who, why: 'fewer than two fact columns'});
        const rights = columns.map(c => Math.max(...c.items.map(i => i.getBoundingClientRect().right)));
        const lefts = [...columns.slice(1).map(c => c.left), accent.getBoundingClientRect().left];
        const gaps = lefts.map((l, i) => l - rights[i]);
        if (Math.max(...gaps) - Math.min(...gaps) > 2) fails.push({who, why: 'column gaps differ', gaps: gaps.map(g => +g.toFixed(1))});
        const run = accent.getBoundingClientRect().left - Math.max(...columns[columns.length - 1].items.map(textRight));
        if (run > 96) fails.push({who, why: `${run.toFixed(0)}px empty before Manual resets, at most 96`});
        const edge = facts.getBoundingClientRect().right - parseFloat(getComputedStyle(facts).paddingRight);
        if (Math.abs(accent.getBoundingClientRect().right - edge) > 2) fails.push({who, why: 'Manual resets does not reach the panel edge', right: Math.round(accent.getBoundingClientRect().right), edge: Math.round(edge)});
      }
      return fails;
    }""")


async def check_predicted_empty(page, state, width):
    """D3: the Usage fact names the active window: "Predicted empty (Weekly)", like "Burn rate (3h)"."""
    if state != "expanded":
        return []
    return await page.evaluate("() => {" + D_PRELUDE + r"""
      const rows = [...document.querySelectorAll('article details[open]')];
      if (!rows.length) return [{why: 'no open row to measure'}];
      const labels = rows.flatMap(row => [...row.querySelectorAll('[class*="__accountFacts___"] dt')].filter(shown).map(dt => dt.textContent.trim()).filter(t => /^Predicted empty/.test(t)));
      if (!labels.length) return [{why: 'no Predicted empty label to measure'}];
      return labels.filter(t => !/^Predicted empty \((Weekly|5-hour)\)$/.test(t)).map(t => ({why: 'Predicted empty does not name its window', label: t}));
    }""")


async def check_reset_reason(page, name, state):
    """D2: in every opened Manual resets box the reason sits within 8px of the Use reset button and is its
    aria-describedby; a disabled button has a border and text of at least 3:1 against the box, by pixels, and
    looks different from an enabled one wherever both are on the page."""
    if state not in ("expanded", "details") and not name.startswith("reset-confirm"):
        return []
    found = await page.evaluate("() => {" + D_PRELUDE + r"""
      const out = [], boxes = [...document.querySelectorAll('article details[open] section[data-tone="accent"]')];
      for (const [index, section] of boxes.entries()) {
        const button = section.querySelector('button'), note = section.querySelector('p[role="status"]');
        if (!button) continue;
        const row = section.closest('details'), who = row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent;
        const b = button.getBoundingClientRect(), n = note ? note.getBoundingClientRect() : null;
        const dx = n ? Math.max(n.left - b.right, b.left - n.right, 0) : null, dy = n ? Math.max(n.top - b.bottom, b.top - n.bottom, 0) : null;
        const cs = getComputedStyle(button);
        out.push({who, index, disabled: button.disabled, rel: {x: b.left - section.getBoundingClientRect().left, y: b.top - section.getBoundingClientRect().top, w: b.width, h: b.height}, gap: n ? Math.max(dx, dy) : null, noted: !!note && shown(note),
          describedBy: !!note && button.getAttribute('aria-describedby') === note.id,
          box: box(button), area: box(section), style: cs.borderTopStyle, fill: cs.backgroundColor, border: cs.borderTopColor});
      }
      return out;
    }""")
    if not found:
        return [dict(why="no Manual resets button to measure")]
    fails = []
    for item in found:
        who = item["who"]
        if not item["noted"] or not item["describedBy"]:
            fails.append(dict(who=who, why="the reason is missing or not the button's aria-describedby"))
        elif item["gap"] > 8:
            fails.append(dict(who=who, why=f"the reason is {item['gap']:.0f}px from the button, at most 8"))
        if not item["disabled"]:
            continue
        # Pixels, not CSS: shoot the box (scrolled into view) and read the button inside it.
        section = page.locator('article details[open] section[data-tone="accent"]').nth(item["index"])
        im = Image.open(io.BytesIO(await section.screenshot(animations="disabled"))).convert("RGB")
        r = item["rel"]
        b = dict(x=r["x"], y=r["y"], w=r["w"], h=r["h"])
        colors = pixels(im, b)
        if not colors:
            fails.append(dict(who=who, why="the disabled button has no pixels to measure"))
            continue
        bg = colors.most_common(1)[0][0]
        text = max(colors, key=lambda c: ratio(c, bg))
        edge = pixels(im, dict(x=b["x"] + b["w"] * 0.25, y=b["y"] - 1, w=b["w"] * 0.5, h=4))
        line = max(edge, key=lambda c: ratio(c, bg)) if edge else bg
        if ratio(text, bg) < 3 or ratio(line, bg) < 3:
            fails.append(dict(who=who, why="disabled Use reset is too faint", text=round(ratio(text, bg), 2), border=round(ratio(line, bg), 2)))
    enabled = [i for i in found if not i["disabled"]]
    disabled = [i for i in found if i["disabled"]]
    for off in disabled:
        for on in enabled[:1]:
            if (off["style"], off["fill"]) == (on["style"], on["fill"]):
                fails.append(dict(who=off["who"], why="disabled Use reset looks like an enabled one", style=off["style"], fill=off["fill"]))
    if name.startswith("reset-confirm") and not enabled:
        fails.append(dict(why="no usable-reset account to compare with"))
    return fails


async def check_reset_dialog(page, dialog):
    """D4/D5: the reset confirmation names the limit windows it restores, and its close button is a 44x44 target
    with a visible focus ring."""
    fails = []
    text = await dialog.inner_text()
    if not ("5-hour" in text and "Weekly" in text):
        fails.append(dict(why="the dialog does not name the limit windows", text=text[:200]))
    close = dialog.get_by_role("button", name="Close", exact=True)
    if await close.count() != 1:
        return fails + [dict(why="no single Close button in the dialog")]
    await page.keyboard.press("Tab")  # keyboard modality, so programmatic focus shows its ring
    await close.focus()
    reading = await close.evaluate("""b => {
      const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      return {w: r.width, h: r.height, ring: b.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth)};
    }""")
    if reading["w"] < 44 or reading["h"] < 44:
        fails.append(dict(why=f"Close is {reading['w']:.0f}x{reading['h']:.0f}, expected at least 44x44"))
    if not reading["ring"] or reading["style"] == "none" or reading["width"] < 2:
        fails.append(dict(why="Close shows no focus ring", **reading))
    return fails


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
        ("reset-confirm", "ready", 390, 844),
        ("reset-confirm-wide", "ready", 1440, 900),
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
        ("expanded-tablet", "expanded", 820, 1000),
        ("expanded-1100", "expanded", 1100, 900),
        ("expanded-1280", "expanded", 1280, 900),
        ("expanded-1440", "expanded", 1440, 1000),
        ("drain", "drain", 1440, 1000),
        ("deep-link", "deep-link", 1440, 1000),
        ("burn-narrow", "burn", 390, 844),
        ("drain-narrow", "drain", 390, 844),
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
        ("partial-affected-narrow", "partial", 390, 844),
        ("stale-narrow", "stale", 390, 844),
        ("collecting-narrow", "collecting", 390, 844),
        ("refresh-pending-narrow", "refresh-pending", 390, 844),
        ("stacked-wide", "stacked", 1920, 1280),
        ("stacked-narrow", "stacked", 390, 844),
        ("stacked-unavailable", "stacked-unavailable", 1440, 1000),
        ("tablet", "ready", 820, 1000),
        ("laptop-1100", "ready", 1100, 900),
        ("narrow-320", "ready", 320, 700),
        ("stale-minimized", "stale", 1440, 1000),
        ("many-low-minimized", "many-low", 1440, 1000),
        ("multi-low-minimized", "multi-low", 1440, 1000),
        ("stale-minimized-1920", "stale", 1920, 1280),
        ("many-low-minimized-1920", "many-low", 1920, 1280),
        ("multi-low-minimized-1920", "multi-low", 1920, 1280),
        ("wide-minimized-1100", "multi-low", 1100, 900),
        ("wide-minimized-1280", "multi-low", 1280, 900),
        ("wide-minimized-1440", "multi-low", 1440, 1000),
        ("wide-minimized-1920", "multi-low", 1920, 1280),
        ("long-minimized-901", "long-name", 901, 900),
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
                reset_spends = []
                credential_reads = []

                async def route_api(route):
                    nonlocal pending_until, collection_requests
                    url = route.request.url
                    if "/requests/api-call" in url:
                        body = route.request.post_data_json
                        if body.get("method") == "POST" and any(part in body.get("url", "") for part in ("consume", "claim", "reset_rate_limits")):
                            reset_spends.append(body)
                        await route.fulfill(status=400, json={"error": "Unexpected provider call in cancel-only fixture"})
                        return
                    if "/credentials" in url:
                        credential_reads.append(url)
                        await route.fulfill(json={"files": [dict(name=f"fixture-{provider}.json", type=provider, auth_index=f"fixture-{provider}-0", disabled=False) for provider in ("claude", "codex")]})
                        return
                    if "/prox/inventory" in url:
                        # One fixed version, so the five-second inventory poll never refetches mid-capture.
                        await route.fulfill(json={"version": "fixture", "syncedAtMs": NOW, "sources": []})
                        return
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
                        query = parse_qs(urlparse(url).query)
                        # A 5-hour request gets the 5-hour fixture, so its numbers match the view.
                        five_hour = query.get("window", [""])[0] == "five-hour"
                        data = fixture("no-limit" if state == "deep-link" and five_hour else state)
                        # Echo the requested view, as the server does, so a deep link's controls and content agree.
                        if "window" in query:
                            data["window"] = query["window"][0]
                        if "lookback" in query:
                            data["lookbackHours"] = int(query["lookback"][0])
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

                async def local_only(route):
                    if route.request.url.startswith(args.url + "/"):
                        await route.continue_()
                    else:
                        await route.abort()
                await context.route("**/*", local_only)
                await page.route("**/prox/sources.json", lambda route: route.fulfill(status=404))
                await page.route("**/v8/management/**", route_api)
                # A busy machine sometimes leaves the first load blank: reload up to twice before failing.
                for attempt in range(3):
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
                        break
                    except Exception:
                        print("Fixture navigation failed", name, page.url, errors, flush=True)
                        await page.screenshot(path=str(out / "navigation-error.png"),full_page=True)
                        if attempt == 2:
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
                dialog_failures = []
                if name.startswith("reset-confirm"):
                    codex = page.locator('article[class*="__codex___"]')
                    row = codex.locator('details[class*="__account___"]').filter(has_text="Resets 2").first
                    await row.locator("summary").click()
                    use_reset = row.get_by_role("button", name="Use reset", exact=False)
                    await use_reset.wait_for()
                    await use_reset.click()
                    dialog = page.get_by_role("dialog")
                    await dialog.wait_for()
                    await page.screenshot(path=str(out / f"{name}-dialog.png"), full_page=True, animations="disabled")
                    dialog_failures = await check_reset_dialog(page, dialog)
                    await dialog.get_by_role("button", name="Cancel", exact=True).click()
                    await dialog.wait_for(state="hidden")
                    # The shared credential inventory loads once with the page; the row reads it from there.
                    assert credential_reads, "Expanded row must resolve its source credential"
                    assert not reset_spends, "Cancel must never consume a credit or claim a grant"
                    claude_row = page.locator('article[class*="__claude___"] details[class*="__account___"]').first
                    await claude_row.locator("summary").click()
                    assert await claude_row.get_by_role("button", name="Use reset", exact=False).is_disabled()
                    assert await claude_row.get_by_text("Usable once a limit is reached", exact=False).is_visible()
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
                        assert "may share accounts" in await combined.inner_text()
                if state in ("drain", "burn"):
                    await switch_view(page, "Drain rate" if state == "drain" else "Burn rate")
                if state == "no-limit":
                    await switch_view(page, "5-hour")
                if state == "details":
                    await (
                        page.locator('details[class*="__account___"]')
                        .first.locator("summary")
                        .click()
                    )
                if state == "many-lowest":
                    await page.get_by_role("combobox", name="Sort accounts").first.select_option("lowest")
                if state == "many-low":
                    await page.get_by_role("button", name="40 with a limit below 20%").first.click()
                if state == "deep-link":
                    # The address holds the view: a link opens it, and changing the view rewrites
                    # the address with only the non-default keys.
                    await page.evaluate("location.hash = '/quota?window=five-hour&mode=burn&lookback=6'")
                    await page.get_by_role("button", name="Burn rate", exact=True).and_(
                        page.locator('[aria-pressed="true"]')).wait_for()
                    pressed = await page.locator('fieldset [aria-pressed="true"]').all_inner_texts()
                    interval = await page.get_by_role("combobox", name="Averaged over", exact=True).input_value()
                    await page.get_by_role("button", name="Remaining", exact=True).click()
                    await page.wait_for_function("!location.hash.includes('mode=')")
                    address = await page.evaluate("location.hash")
                    if pressed != ["5-hour", "Burn rate"] or interval != "6" or address != "#/quota?window=five-hour&lookback=6":
                        errors.append(f"deep-link: pressed={pressed} interval={interval} address={address}")
                if name == "partial-affected-narrow":
                    # The notice's action filters its card's list to the affected rows and focuses the first.
                    show = page.get_by_role("button", name="Show affected accounts").first
                    # The button relabels itself once the filter is on, so pin its card first.
                    index = await show.evaluate("b => [...document.querySelectorAll('article')].indexOf(b.closest('article'))")
                    card = page.locator("article").nth(index)
                    await show.click()
                    rows = await card.locator('details[class*="__account___"]').count()
                    focused = await page.evaluate("document.activeElement && document.activeElement.tagName")
                    if rows != 1 or focused != "SUMMARY":
                        errors.append(f"show-affected: rows={rows} focus={focused}")
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
                if args.minimize_cards or name in MINIMIZED_CASES:
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
                # Read before the other checks, which collapse rows; the pixels come from the shot just taken.
                reset_reason_failures = await check_reset_reason(page, name, state)
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
                results[name]["factWrapFailures"] = await check_fact_wrap(page, state, width)
                results[name]["toggleConsistencyFailures"] = await check_toggle_consistency(page, state, width)
                results[name]["phoneHeaderFailures"] = await check_phone_header(page, state, width)
                results[name]["actionNameFailures"] = await check_action_names(page, state, width)
                results[name]["headerOrderFailures"] = await check_header_order(page, state, width)
                results[name]["headerActionLabelFailures"] = await check_header_action_labels(page, state, width)
                results[name]["lowColourFailures"] = await low_colour_failures(page, state)
                results[name]["staleDimFailures"] = await stale_dim_failures(page, state)
                results[name]["staleLabelFailures"] = await stale_label_failures(page, state)
                results[name]["staleLabelFailures"] += await stale_sweep_failures(browser, args.url, name)
                results[name]["renewalCaveatFailures"] = await renewal_caveat_failures(page, context, args.url, route_api, name, state)
                results[name]["minimizedProximityFailures"] = await minimized_width_failures(page, name)
                results[name]["minimizedProximityFailures"] += await minimized_sweep_failures(browser, args.url, name)
                results[name]["toolbarBudgetFailures"] = await check_toolbar_budget(page, name, results[name])
                results[name]["lowInlineFailures"] = await check_low_inline(page, state)
                results[name]["forecastRowFailures"] = await check_forecast_row(page, state, width)
                results[name]["actionAlignFailures"] = await check_action_align(page, state)
                await run_g_checks(browser, args.url, name, state, page, results[name])
                results[name]["phonePanelOrderFailures"] = await check_panel_order(page, state, width)
                results[name]["skeletonShapeFailures"] = await check_skeleton_shape(browser, args.url, page, name, state, width)
                results[name]["expandedDuplicateFailures"] = await check_expanded_duplicates(page, state, width)
                results[name]["phoneRowBlockFailures"] = await check_phone_row_blocks(page, name, state, width)
                results[name]["phoneHeaderConsistencyFailures"] = await check_header_consistency(browser, args.url, page, name, state, width)
                results[name]["phoneTrackFailures"] = await check_phone_tracks(page, name)
                results[name]["phoneToggleFailures"] = await check_phone_toggle(page, name, width)
                results[name]["phoneCountsNoteFailures"] = await check_phone_counts_note(page, name, width)
                results[name]["phoneForecastStackFailures"] = await check_phone_forecast_stack(page, name, width)
                results[name]["rosterCountFailures"] = await check_roster_count(context, args.url, route_api, name, state)
                results[name]["filterChipFailures"] = await check_filter_chip(context, args.url, route_api, name, state)
                results[name]["rosterToolbarFailures"] = await check_roster_toolbar(context, args.url, route_api, name, state)
                results[name]["summaryFactFailures"] = await check_summary_facts(page, context, args.url, route_api, name, state)
                results[name]["statusChipFailures"] = await check_status_chip(page, context, args.url, route_api, name, state)
                results[name]["factPanelGapFailures"] = await check_fact_panel_gap(page, state, width)
                results[name]["predictedEmptyFailures"] = await check_predicted_empty(page, state, width)
                results[name]["resetReasonFailures"] = reset_reason_failures
                results[name]["resetDialogFailures"] = dialog_failures
                results[name]["captionFailures"] = await check_captions(page, name, state, width)
                results[name]["searchLabelFailures"] = await check_search_label(page, name, state)
                results[name]["rateBalanceFailures"] = await check_rate_balance(page, name, state)
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
                                    name:row.querySelector('[class*="__accountLabel___"]').firstChild.textContent,
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
                                    # A closed minimized row shows its low limits; from 901px the active window's own value
                                    # sits in the primary column, so that limit isn't repeated among the other low limits.
                                    assert await row.locator('ul[aria-label="Limits"] li').evaluate_all("(nodes,wide)=>nodes.every(n=>n.checkVisibility()===(n.dataset.low==='true'&&!(wide&&n.dataset.counted==='true')))", width >= 901)
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
                if name in MINIMIZED_CASES:
                    # The wide minimized list has its own columns; minimizedProximityFailures measures them.
                    pass
                elif width >= 901:
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
                    # Stacked: a block is label and value on one line over its bar; every value ends on the row's
                    # content edge (a block row's list takes no box of its own, so the edge is the summary's).
                    alignment = await page.locator('article details:not([open]) ul[aria-label="Limits"]').evaluate_all('''lists => lists.flatMap(list => {
                        const summary = list.parentElement, edge = summary.getBoundingClientRect().right - parseFloat(getComputedStyle(summary).paddingRight);
                        return [...list.children].filter(li => li.checkVisibility()).map(li => {
                            const label = li.querySelector(':scope > span').getBoundingClientRect();
                            const value = li.querySelector(':scope > strong, :scope > em').getBoundingClientRect();
                            // Phones put the label on its own single line above its bar and value; wide rows share one line.
                            const above = value.top >= label.bottom - 2;
                            return {rightOffset:Math.abs(edge-value.right), lineOffset:above ? (label.height < 24 ? 0 : 99) : Math.abs(label.top-value.top)};
                        });
                    })''')
                    assert all(cell['rightOffset'] < 1 and cell['lineOffset'] < 12 for cell in alignment), f"Misaligned collapsed limits: {alignment}"
                interaction["collapsed_labels_and_values_align"] = "see minimizedProximityFailures" if name in MINIMIZED_CASES else "passed"
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
                    geometry = await corner.locator('button').evaluate_all("nodes=>nodes.filter(n=>n.checkVisibility()).map(n=>{const r=n.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,text:n.innerText}})")
                    # An impossible move isn't drawn, so the first card shows its toggle and Move down only.
                    # They share one row from 360px up; a 320px card is too narrow for two pills, so they wrap, left-aligned.
                    assert len(geometry)==2, geometry
                    if width>=360: assert all(abs(c['y']-geometry[0]['y'])<1 for c in geometry), geometry
                    else: assert all(abs(c['x']-geometry[0]['x'])<1 for c in geometry), geometry
                    # Every action names itself beside its icon at every width: 32px tall, 44px on touch.
                    assert all(c['text'].strip() for c in geometry), geometry
                    assert all(abs(c['h']-(44 if width<600 else 32))<1 for c in geometry), geometry
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
                    today = page.get_by_role("button", name="Today", exact=True)
                    assert await today.get_attribute("aria-disabled") == "true"
                    await today.focus(); await today.press("Enter")
                    assert await today.evaluate("b => document.activeElement === b"), "Today must keep focus"
                    interaction["today_keeps_focus_when_current"] = "passed"
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
                    await page.get_by_role("button", name=f"Move down ({first.split(' ')[0]})").click()
                    moved = await titles()
                    assert moved[1] == first and moved[0] != first, "Move down must swap the first two pools"
                    stored_order = await page.evaluate("localStorage.getItem('prox-pool-order')")
                    assert stored_order and "codex" in stored_order.split("claude")[0], "The new order must be saved"
                    await page.get_by_role("button", name=f"Move up ({first.split(' ')[0]})").click()
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
                    assert await page.get_by_role("link", name="Open OAuth Login").get_attribute("href") == "#/oauth"
                    interaction["credential_action_targets_login"] = "passed"
                results[name]["optionsSummaryFailures"] = await check_options_summary(page, name, state, width)
                results[name]["optionsOverlayFailures"] = await check_options_overlay(page, name)
                if state == "ready":
                    # Phones fold Rate behind Options; opening it shows the select.
                    options = page.locator(OPTIONS_BUTTON)
                    if await options.is_visible():
                        await options.click()
                        assert await options.get_attribute("aria-expanded") == "true"
                    interval = page.get_by_role("combobox", name="Averaged over", exact=True)
                    async with page.expect_request(
                        lambda request: "/prox/pools?" in request.url and "lookback=6" in request.url
                    ):
                        await interval.select_option("6")
                    assert await interval.input_value() == "6"
                    interaction["rate_interval_updates_request"] = "passed"
                if name.startswith("reset-confirm"):
                    interaction["reset_confirmation_cancel"] = "passed; no consume/claim POST; blocked reason visible"
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
               for key in ["clipped", "targetFailures", "contrastFailures", "semanticFailures", "guideFailures", "inkFailures", "nestingFailures", "hiddenReasonFailures", "overlapFailures",
                        "lowColourFailures", "staleDimFailures", "staleLabelFailures", "renewalCaveatFailures",
                        "minimizedProximityFailures",
                        "toolbarBudgetFailures", "optionsSummaryFailures", "optionsOverlayFailures"]},
            errors=result["errors"],
        )
    for name, result in results.items():
        summary[name].update({key: len(result.get(key, [])) for key in C1_KEYS + P1_KEYS + G_KEYS + H_KEYS + R_KEYS + A_KEYS + B_KEYS + D_KEYS + H1C_KEYS})
    if args.compact_baseline:
        baseline = json.loads((ROOT / "docs/evidence/hillclimb" / args.compact_baseline / "measurements.json").read_text())
        for name, result in results.items():
            expected = baseline[name]["accountSections"]
            actual = result["accountSections"]
            assert len(actual) == len(expected), f"{name}: provider sections changed"
            # Waived from 901px: the minimized list is a new grid (header row, value and other-low columns),
            # so its heights and the low-limit alignment under the balance no longer match the old stack.
            # Identity, balance and the warnings' label and value are still compared at every width.
            wide = result["viewport"][0] >= 901
            for section, before in zip(actual, expected):
                assert wide or section["height"] <= before["height"] + 0.5, f"{name}: account section grew"
                assert len(section["rows"]) == len(before["rows"]), f"{name}: account count changed"
                for row, old in zip(section["rows"], before["rows"]):
                    assert row["name"] == old["name"] and row["balance"] == old["balance"], f"{name}: identity or balance changed"
                    assert wide or row["height"] <= old["height"] + 0.5, f"{name}: account row grew"
                    assert wide or row["nameHeight"] <= old["nameHeight"] + 0.5, f"{name}: name gained a line"
                    assert len(row["warnings"]) == len(old["warnings"]), f"{name}: warnings changed"
                    for warning, prior in zip(row["warnings"], old["warnings"]):
                        assert warning["label"] == prior["label"] and warning["value"] == prior["value"], f"{name}: warning meaning changed"
                        assert wide or warning["height"] <= prior["height"] + 0.5, f"{name}: warning gained a line"
                        assert wide or abs(warning["valueRight"] - row["balanceRight"]) <= 0.5, f"{name}: warning no longer aligns with its account balance"
                result["compactBaseline"] = args.compact_baseline
        saved.write_text(json.dumps(results, indent=2) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    if args.assert_compact:
        assert all(not value for case in summary.values() for value in case.values()), "Rendered checks failed; inspect summary.json"



if __name__ == "__main__":
    asyncio.run(main())

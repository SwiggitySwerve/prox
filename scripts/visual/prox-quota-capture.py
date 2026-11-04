"""Repeatable browser fixtures for Prox UI review; never reads real credentials."""

import argparse
import asyncio
import colorsys
import json
import hashlib
import math
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
  const clipped=[...root.querySelectorAll('*')].filter(e=>visible(e)&&e.clientWidth>2&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>({tag:e.tagName,class:e.className,client:e.clientWidth,scroll:e.scrollWidth}));
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
MINIMIZED_CASES = ("stale-minimized", "many-low-minimized", "multi-low-minimized")


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
    """I3: every stale row shows the amber "Stale" word, a clock icon and its timestamp on one line."""
    if state != "stale":
        return []
    return await page.evaluate("() => {" + C3_HELPERS + r"""
      const out=[],rows=[...document.querySelectorAll('article details[data-status="stale"]')];
      if(!rows.length)out.push({why:'no stale row'});
      for(const row of rows){
        const where=row.querySelector('[class*="__accountLabel___"]')?.firstChild?.textContent,status=row.querySelector('[class*="__accountStatus___"]');
        if(!status||!shown(status)){out.push({where,why:'status line is not visible'});continue;}
        const icon=status.querySelector('svg'),size=parseFloat(getComputedStyle(status).fontSize),box=status.getBoundingClientRect(),summary=row.querySelector('summary').getBoundingClientRect();
        if(!/^Stale\b/.test(status.textContent.trim()))out.push({where,why:'status does not start with "Stale"'});
        if(!icon||icon.getAttribute('aria-hidden')!=='true'||!shown(icon)||!icon.matches('[class*="__staleIcon___"]'))out.push({where,why:'no visible aria-hidden clock icon'});
        if(!/\d{1,2}:\d{2}/.test(status.textContent))out.push({where,why:'no timestamp'});
        if(box.height>size*1.8)out.push({where,why:'status wraps onto '+Math.round(box.height/size)+' lines'});
        if(status.scrollWidth>status.clientWidth+1||textRight(status)>summary.right+1)out.push({where,why:'status overflows its row'});
      }
      return out;
    }""")


async def renewal_caveat_failures(page, state, width):
    """I4: one caveat in each Accounts section with an estimated renewal, none elsewhere; short basis on one line."""
    if state in C3_NO_ROSTER:
        return []
    caveat = '[class*="__renewalCaveat___"]'
    measure_once = "() => {" + C3_HELPERS + r"""
      const out=[],text="Renewal dates are estimated from each plan's start date; annual plans differ.";
      for(const article of document.querySelectorAll('article')){
        const section=article.querySelector('section[class*="__accounts___"]');
        // Fixture: every Claude account's renewal is estimated from its start date; Codex reports its dates.
        const want=/claude/i.test(article.querySelector('h2').textContent)?1:0,got=[...section.querySelectorAll('""" + caveat + r"""')];
        if(got.length!==want)out.push({why:'expected '+want+' caveat(s), found '+got.length,card:article.querySelector('h2').textContent});
        for(const c of got){
          if(c.textContent.trim()!==text||!shown(c))out.push({why:'caveat text or visibility is wrong'});
          if(c.previousElementSibling?.tagName!=='H3')out.push({why:'caveat is not directly under the Accounts header'});
        }
        const mentions=(section.innerText.match(/annual plans differ/gi)||[]).length;
        if(mentions!==want)out.push({why:'"annual plans differ" appears '+mentions+' times, expected '+want});
      }
      const outside=[...document.querySelectorAll('""" + caveat + r"""')].filter(c=>!c.closest('section[class*="__accounts___"]'));
      if(outside.length)out.push({why:'caveat outside an Accounts section'});
      return out;
    }"""
    out = await page.evaluate(measure_once)
    # Search, filter and paging never hide it: a search with no match leaves the same caveat.
    search = page.get_by_role("searchbox", name="Search accounts").first
    if await search.count():
        original = await search.input_value()
        await search.fill("zzzz-no-match")
        out += [dict(f, during="no-match search") for f in await page.evaluate(measure_once)]
        await search.fill(original)
    if state == "expanded":
        out += await page.evaluate("() => {" + C3_HELPERS + r"""
          const out=[],basis=[...document.querySelectorAll('[class*="__detail___"]')].filter(e=>/^Estimated/.test(e.textContent.trim()));
          if(!basis.length)out.push({why:'no displayed estimated renewal to measure'});
          for(const e of basis){const fs=parseFloat(getComputedStyle(e).fontSize);
            if(e.textContent.trim()!=='Estimated · from start date')out.push({why:'basis reads "'+e.textContent.trim()+'"'});
            if(e.getBoundingClientRect().height>fs*1.8||e.scrollWidth>e.clientWidth+1)out.push({why:'basis wraps or is clipped'});}
          return out;
        }""")
    return out


async def minimized_width_failures(page, name):
    """I5: the minimized wide list spans the card's content, with column edges shared by every row."""
    if name not in MINIMIZED_CASES:
        return []
    return await page.evaluate("() => {" + C3_HELPERS + r"""
      const out=[],cards=[...document.querySelectorAll('article')].filter(a=>a.querySelector('section[class*="__accounts___"] details'));
      if(!cards.length)out.push({why:'no card with account rows'});
      for(const a of cards){
        const cs=getComputedStyle(a),box=a.getBoundingClientRect(),left=box.left+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth),
          width=box.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-parseFloat(cs.borderLeftWidth)-parseFloat(cs.borderRightWidth),
          card=a.querySelector('h2').textContent,head=[...a.querySelectorAll('[class*="__compactHead___"] > span')].filter(shown),
          rows=[...a.querySelectorAll('details:not([open])')].filter(shown);
        if(head.length!==3||!rows.length){out.push({card,why:'missing header or rows'});continue;}
        const chev=rows.map(r=>r.querySelector('summary > svg').getBoundingClientRect().left),
          vals=rows.map(r=>r.querySelector('summary > strong').getBoundingClientRect().right),
          valText=rows.map(r=>textRight(r.querySelector('summary > strong'))),
          lis=rows.flatMap(r=>[...r.querySelectorAll('ul[aria-label="Limits"] li')].filter(shown)),
          rights=[...valText,...lis.map(li=>textRight(li.querySelector('strong')))],
          listLeft=Math.min(...chev,head[0].getBoundingClientRect().left),listRight=Math.max(...rights);
        const same=(xs,tol=1)=>Math.max(...xs)-Math.min(...xs)<=tol;
        if((listRight-listLeft)/width<0.85)out.push({card,why:'content spans '+((listRight-listLeft)/width).toFixed(2)+' of the card content'});
        if((Math.min(...valText)-left)/width<0.70)out.push({card,why:'primary value edge at '+((Math.min(...valText)-left)/width).toFixed(2)});
        if(!same(chev))out.push({card,why:'chevrons are not aligned'});
        if(!same(vals))out.push({card,why:'primary value edges are not aligned'});
        if(Math.abs(head[1].getBoundingClientRect().right-vals[0])>1)out.push({card,why:'value header and value edge differ'});
        if(!lis.length)out.push({card,why:'no other low limit shown'});
        else{
          if(!same(lis.map(li=>li.getBoundingClientRect().left)))out.push({card,why:'other-low items are not aligned'});
          if(Math.abs(head[2].getBoundingClientRect().left-lis[0].getBoundingClientRect().left)>1)out.push({card,why:'other-low header and items differ'});
          for(const li of lis)if(!li.firstElementChild.textContent.trim()||!/%/.test(li.querySelector('strong').textContent)||!li.querySelector('[class*="__limitWarning___"] svg')||li.querySelector('[class*="__lowWord___"]')?.textContent.trim()!=='Low')out.push({card,why:'other-low item lacks label, value, icon or "Low"'});
          if(lis.some(li=>li.dataset.counted==='true'))out.push({card,why:'the active window is repeated in other low limits'});
        }
        for(const r of rows){const chip=r.querySelector('[class*="__accountResetMarker___"]');if(chip&&chip.getBoundingClientRect().right>r.querySelector('summary > strong').getBoundingClientRect().left)out.push({card,why:'reset chip left the Account cell'});}
        // Opening a row restores every limit and fact across the whole list width.
        const row=rows[0],before=row.querySelectorAll('ul[aria-label="Limits"] li').length;row.open=true;
        const grid=row.parentElement.getBoundingClientRect(),opened=row.getBoundingClientRect();
        const limits=[...row.querySelectorAll('ul[aria-label="Limits"] li')];
        if(opened.width<grid.width-1)out.push({card,why:'open row does not span the list'});
        if(!limits.every(shown)||limits.length!==before||!shown(row.querySelector('[class*="__accountFacts___"]')))out.push({card,why:'open row did not restore its limits and facts'});
        row.open=false;
      }
      return out;
    }""")


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
    """I4: at 390 a provider card's top to its headline number's top is at most 150px."""
    if width != 390:
        return []
    return await page.evaluate("(cardless) => {" + C1_PRELUDE + r"""
      const fails = [], articles = [...document.querySelectorAll('article')];
      if (!cardless && !articles.length) fails.push({why: 'no provider cards found'});
      for (const a of articles) {
        const n = a.querySelector('[class*="__headline___"] strong');
        if (!n) { fails.push({why: 'card has no headline number'}); continue; }
        const d = n.getBoundingClientRect().top - a.getBoundingClientRect().top;
        if (d > 150) fails.push({card: a.querySelector('h2')?.textContent, why: `headline number starts ${d.toFixed(0)}px below the card top`});
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
    expected = ["5-hour" if state == "no-limit" else "Weekly", "Drain rate" if state == "drain" else "Burn rate" if state == "burn" else "Remaining", "3h"]
    failures = []
    text = await toggle.inner_text()
    failures += [dict(why=f"summary lacks {item!r}", text=text) for item in expected if item not in text]
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
        ("deep-link", "deep-link", 1440, 1000),
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
                if name == "reset-confirm":
                    codex = page.locator('article[class*="__codex___"]')
                    row = codex.locator('details[class*="__account___"]').filter(has_text="Resets 2").first
                    await row.locator("summary").click()
                    use_reset = row.get_by_role("button", name="Use reset", exact=False)
                    await use_reset.wait_for()
                    await use_reset.click()
                    dialog = page.get_by_role("dialog")
                    await dialog.wait_for()
                    await page.screenshot(path=str(out / "reset-confirm-dialog.png"), full_page=True, animations="disabled")
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
                results[name]["renewalCaveatFailures"] = await renewal_caveat_failures(page, state, width)
                results[name]["minimizedWidthFailures"] = await minimized_width_failures(page, name)
                results[name]["toolbarBudgetFailures"] = await check_toolbar_budget(page, name, results[name])
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
                    # The wide minimized list has its own columns; minimizedWidthFailures measures them.
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
                    # Stacked: label | bar | value rows; every value ends on the list's right edge.
                    alignment = await page.locator('article details:not([open]) ul[aria-label="Limits"]').evaluate_all('''lists => lists.flatMap(list => {
                        const edge = list.getBoundingClientRect().right;
                        return [...list.children].filter(li => li.checkVisibility()).map(li => {
                            const label = li.querySelector(':scope > span').getBoundingClientRect();
                            const value = li.querySelector(':scope > strong').getBoundingClientRect();
                            // Phones put the label on its own single line above its bar and value; wide rows share one line.
                            const above = value.top >= label.bottom - 2;
                            return {rightOffset:Math.abs(edge-value.right), lineOffset:above ? (label.height < 24 ? 0 : 99) : Math.abs(label.top-value.top)};
                        });
                    })''')
                    assert all(cell['rightOffset'] < 1 and cell['lineOffset'] < 12 for cell in alignment), f"Misaligned collapsed limits: {alignment}"
                interaction["collapsed_labels_and_values_align"] = "see minimizedWidthFailures" if name in MINIMIZED_CASES else "passed"
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
                if name == "reset-confirm":
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
                        "lowColourFailures", "staleDimFailures", "staleLabelFailures", "renewalCaveatFailures", "minimizedWidthFailures",
                        "toolbarBudgetFailures", "optionsSummaryFailures", "optionsOverlayFailures"]},
            errors=result["errors"],
        )
    for name, result in results.items():
        summary[name].update({key: len(result.get(key, [])) for key in C1_KEYS})
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

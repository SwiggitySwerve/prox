"""Synthetic full-App browser smoke. Run against a local Vite server; no production APIs.

uv run --with playwright python scripts/visual/prox-sources-capture.py --url http://127.0.0.1:5199
Uses an isolated browser profile and an installed Playwright Chromium by default.
"""
import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
ROUTES = [
    ('auth-files', '/auth-files'), ('quota-accounts', '/quota/accounts'),
    ('providers', '/ai-providers'), ('dashboard', '/dashboard'), ('plugins', '/plugins'),
    ('plugin-store', '/plugin-store'), ('system-beta', '/system?source=beta'),
    ('config-beta', '/config?source=beta'), ('logs-beta', '/logs?source=beta'),
    ('oauth-beta', '/oauth?source=beta'),
    ('excluded-beta', '/auth-files/oauth-excluded?source=beta&provider=claude'),
    ('alias-beta', '/auth-files/oauth-model-alias?source=beta&provider=claude'),
]

async def settle(page):
    await page.wait_for_function('window.__sourceSmoke?.ready === true', timeout=30000)
    await page.locator('main').wait_for(timeout=15000)
    # Let effects, route transitions, and nested synthetic reads settle; no real backend wait.
    await page.wait_for_timeout(1000)
    for node in await page.locator('main h1,main h2').all():
        if await node.is_visible():
            await node.scroll_into_view_if_needed()
    await page.locator('main').evaluate('(e)=>{e.scrollTop=0;window.scrollTo(0,0)}')
    await page.wait_for_timeout(200)

async def capture(page, out, name):
    await page.screenshot(path=str(out / f'{name}.png'), full_page=True)
    return await page.evaluate('''() => {
      const main=document.querySelector('main');
      const text=main?.innerText||'';
      return {shell:!!main && !!document.querySelector('header'),
        pressedSource:document.querySelector('[role=group][aria-label="Management source"] [aria-pressed=true]')?.textContent.trim()||null,
        sourceLabels:['Alpha fixture','Beta fixture'].filter(s=>text.includes(s)),
        headings:[...main.querySelectorAll('h1,h2')].map(e=>e.textContent.trim()).slice(0,20),
        alerts:[...main.querySelectorAll('[role=alert]')].map(e=>e.textContent.trim()).filter(Boolean),
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        overflowElements:[...main.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left < -1)&&getComputedStyle(e).position!=='fixed';}).slice(0,8).map(e=>({tag:e.tagName,class:String(e.className).slice(0,100)})),
        secretSentinelVisible:document.body.innerText.includes('FIXTURE_ACCOUNT_MUST_NOT_RENDER'),
        requests:window.__sourceSmoke.requests};
    }''')

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:5199')
    parser.add_argument('--browser')
    parser.add_argument('--out',default='docs/evidence/provider-sources/browser')
    parser.add_argument('--cases',nargs='*',help='Optional route slugs for a focused rerun')
    args=parser.parse_args()
    origin=urlparse(args.url)
    if origin.scheme!='http' or origin.hostname not in ('127.0.0.1','localhost','[::1]'):
        parser.error('Only a local HTTP Vite server is allowed')
    out=ROOT/args.out
    out.mkdir(parents=True,exist_ok=True)
    browsers=sorted((Path.home()/'.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    executable=args.browser or (str(browsers[-1]) if browsers else None)
    report={'startedAt':datetime.now(timezone.utc).isoformat(),'scope':'Actual App + MainLayout + hash routes; synthetic login, Axios adapter, discovery; no production.', 'cases':{},'actions':{}}
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
        report['browser']=f'Playwright headless Chromium {browser.version}'
        try:
            for width,height in [(1440,1000),(390,844)]:
                for slug,route_path in ROUTES:
                    if args.cases and slug not in args.cases: continue
                    name=f'{slug}-{width}'
                    context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=width<600,has_touch=width<600,locale='en-US',timezone_id='UTC',color_scheme='light',reduced_motion='reduce',service_workers='block')
                    page=await context.new_page()
                    page.set_default_timeout(7000)
                    errors=[]; blocked=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    async def intercept(route):
                        url=urlparse(route.request.url)
                        if url.netloc!=origin.netloc or '/v8/management' in url.path or url.path.startswith('/v1/'):
                            blocked.append({'method':route.request.method,'url':f'{url.scheme}://{url.netloc}{url.path}'})
                            await route.abort(); return
                        if url.path=='/src/main.tsx':
                            await route.fulfill(content_type='application/javascript',body="import '/scripts/visual/prox-sources-capture.ts';")
                        else: await route.continue_()
                    await context.route('**/*',intercept)
                    result={}
                    try:
                        await page.goto(f'{args.url}/#{route_path}',wait_until='domcontentloaded',timeout=30000)
                        await settle(page)
                        result=await capture(page,out,name)
                        selected='source=beta' in route_path
                        if slug=='plugin-store':
                            # Installs need an explicit destination (council decision §4): no default source,
                            # so check the picker offers every source instead of inventory labels on the page.
                            await page.get_by_role('button',name='Destination').click()
                            options=await page.get_by_role('option').all_inner_texts()
                            await page.keyboard.press('Escape')
                            result['sourceLabels']=[s for s in ['Alpha fixture','Beta fixture'] if s in options]
                        result['sourceVisibilityPass']=all(s in result['sourceLabels'] for s in (['Beta fixture'] if selected else ['Alpha fixture','Beta fixture']))
                        result['passiveOperationsPass']=not any(r['forbidden'] for r in result['requests'])
                        result['fixtureCoveragePass']=not any(r.get('unexpected') for r in result['requests'])
                        result['screenshot']=f'{name}.png'
                        result['selectedToolbarPass']=not selected or result['pressedSource']=='Beta fixture'
                        if slug=='auth-files' and width==1440:
                            try: await action_smoke(page,out,report['actions'])
                            except Exception as error: report['actions']['authActions']={'pass':False,'error':str(error)}
                        if slug=='system-beta' and width==1440:
                            try: await destination_smoke(page,out,report['actions'])
                            except Exception as error: report['actions']['destinationSwitch']={'pass':False,'error':str(error)}
                    except Exception as error:
                        result['harnessError']=str(error)
                        await page.screenshot(path=str(out/f'{name}-failure.png'),full_page=True)
                    result.update(errors=errors,blockedNetwork=blocked,route=route_path,width=width)
                    result['pass']=all(result.get(key,False) for key in ['shell','sourceVisibilityPass','passiveOperationsPass','fixtureCoveragePass','selectedToolbarPass']) and not any(result.get(key) for key in ['overflow','secretSentinelVisible','errors','blockedNetwork','harnessError'])
                    report['cases'][name]=result
                    print(f'{name}: {"PASS" if result["pass"] else "FINDING"}',flush=True)
                    await context.close()
                    (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
        finally: await browser.close()
    report['finishedAt']=datetime.now(timezone.utc).isoformat()
    (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    findings=[name for name,value in report['cases'].items() if not value['pass']]
    print(json.dumps({'cases':len(report['cases']),'findings':findings,'actions':report['actions']}),flush=True)
    return 1 if findings or any(v.get('pass') is False for v in report['actions'].values()) else 0

async def action_smoke(page,out,results):
    await page.evaluate("window.__sourceSmoke.phase='action'")
    for source in ['alpha','beta']:
        await page.locator(f'[data-source-id={source}] label:has(input[type=checkbox])').first.click()
    results['independentSelections']={'pass':await page.locator('[role=toolbar]').count()==2}
    await page.locator('[data-source-id=alpha] [role=toolbar]').get_by_role('button',name='Delete',exact=True).click()
    dialog=page.get_by_role('dialog')
    labelled='Alpha fixture' in await dialog.inner_text()
    await dialog.get_by_role('button',name='Confirm',exact=True).click()
    await page.wait_for_timeout(200)
    mutations=await page.evaluate("window.__sourceSmoke.requests.filter(r=>r.method==='delete')")
    results['ownerPinnedDelete']={'pass':labelled and len(mutations)==1 and mutations[0]['source']=='alpha' and mutations[0].get('targets')==['same.json'],'requests':mutations}
    await page.evaluate("window.__sourceSmoke.unauthorized=['beta']")
    await page.locator('[data-source-id=beta]').get_by_role('button',name='Refresh',exact=True).click()
    await page.locator('[data-source-id=beta] [role=alert]').wait_for()
    await page.screenshot(path=str(out/'auth-files-beta-401-1440.png'),full_page=True)
    results['secondary401']={'pass':await page.locator('[data-source-id=alpha] button').count()>0 and await page.locator('[data-source-id=beta] [role=alert]').count()==1,'screenshot':'auth-files-beta-401-1440.png'}

async def destination_smoke(page,out,results):
    owners=await page.evaluate('window.__sourceSmoke.owners()')
    group=page.get_by_role('group',name='Management source',exact=True)
    before=await group.get_by_role('button',name='Beta fixture',exact=True).get_attribute('aria-pressed')
    await page.evaluate('window.__sourceSmoke.requests.length=0')
    await group.get_by_role('button',name='Alpha fixture',exact=True).click()
    await page.wait_for_function("location.hash.includes('source=alpha')")
    await page.wait_for_timeout(500)
    # The routed page, not just the toolbar, must follow the switch (same-path navigation).
    reloaded=sorted({r['source'] for r in await page.evaluate('window.__sourceSmoke.requests')})
    after=await group.get_by_role('button',name='Alpha fixture',exact=True).get_attribute('aria-pressed')
    current=await page.evaluate('window.__sourceSmoke.owners()')
    await page.screenshot(path=str(out/'system-source-switch-1440.png'),full_page=True)
    # Browser Back must restore the page's source along with the URL.
    await page.evaluate('window.__sourceSmoke.requests.length=0')
    await page.go_back()
    await page.wait_for_function("location.hash.includes('source=beta')")
    await page.wait_for_timeout(500)
    reloadedBack=sorted({r['source'] for r in await page.evaluate('window.__sourceSmoke.requests')})
    results['destinationSwitch']={'pass':before=='true' and after=='true' and current==owners and reloaded==['alpha'] and reloadedBack==['beta'],'reloadedSources':reloaded,'reloadedBackSources':reloadedBack,'ownersBefore':owners,'ownersAfter':current,'hash':await page.evaluate('location.hash'),'screenshot':'system-source-switch-1440.png'}

if __name__=='__main__':
    raise SystemExit(asyncio.run(main()))

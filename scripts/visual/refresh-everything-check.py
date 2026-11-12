"""Counts what each refresh click asks of the (fake) hubs, and captures the cards after it.

    uv run -q --with playwright python -I -B scripts/visual/refresh-everything-check.py \
        --url http://127.0.0.1:5199 --out docs/evidence/refresh-everything

fake_hub.FakeHubs answers every request at the network layer (scenario 'many': twelve Claude
accounts on the first hub, so its group has a second page, and two Codex accounts on the second);
nothing reaches a real hub. The page clock is Playwright's fake clock, moved past the 60 s reuse
window instead of waiting. Reset claims are never clicked, and the fake refuses any proxied write.

Checks (each a line in counts.json, the run fails on any miss):
  1. Auth Files "Refresh quota": every quota card is read, including the group's second page.
  2. The same click again inside 60 s: no quota read.
  3. After the window (clock moved 61 s): every card is read again.
  4. Header refresh: each hub's credential list once, the model lists, config; quota cards past
     the window are read, fresh ones are not; busy until all of it settles; one notice.
  5. A hub that answers 401: one request reaches it during the header refresh; the notice says so.
  6. Quota page Refresh all: every card the tab shows; again inside 60 s: none.
  7. Models screen header refresh: credential lists once per hub, model lists re-read.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('fake_hub', Path(__file__).with_name('fake_hub.py'))
fake_hub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fake_hub)

HEADER_REFRESH = 'header .header-actions button[aria-label="Refresh All"]'
# The fake's one quota read that always fails (claude-team-b.json); a failed read is never reused.
FAILING = 'alpha:alpha-1'
MODEL_PATHS = ('/config/oauth/excluded-models', '/config/oauth/model-alias',
               '/routing/model-definitions/', '/credentials/models', '/credentials/download')


def quota_cards(hubs: 'fake_hub.FakeHubs') -> set[tuple[str, str]]:
    """Every credential with quota to read: not runtime-only, not switched off."""
    cards = set()
    for source, hub in hubs.hubs.items():
        for index, account in enumerate(hub['accounts']):
            if not account.get('runtime') and not account['disabled']:
                cards.add((source, f'{source}-{index}'))
    return cards


def is_grants(entry: dict) -> bool:
    # Claude's reset grants are read beside its quota (the card's Manual resets box), whenever
    # the card's quota changes; they are not a quota read.
    return 'cedar_ember' in str(entry.get('url', ''))


def summarize(entries: list[dict]) -> dict:
    quota = [e for e in entries if e['path'] == '/requests/api-call' and not is_grants(e)]
    reads = {(e['source'], e['authIndex']) for e in quota}
    count = lambda pred: sum(1 for e in entries if pred(e))
    return {
        'quotaCards': sorted(f'{s}:{a}' for s, a in reads),
        'quotaCalls': len(quota),
        'grantReads': count(lambda e: is_grants(e)),
        'credentialLists': {s: count(lambda e, s=s: e['path'] == '/credentials' and e['source'] == s)
                            for s in ('alpha', 'beta')},
        'modelReads': count(lambda e: e['path'].startswith(MODEL_PATHS)),
        'config': count(lambda e: e['path'] == '/config'),
        'plugins': count(lambda e: e['path'] == '/plugins'),
        'proxiedWrites': count(lambda e: e.get('proxied', 'GET') != 'GET'),
        'perHub': {s: count(lambda e, s=s: e['source'] == s) for s in ('alpha', 'beta')},
    }


async def settle(page, hubs, quiet_ms=1200, timeout_ms=30000):
    """Wait until no request has reached the hubs for quiet_ms and nothing shows as busy."""
    waited, last, still = 0, -1, 0
    while waited < timeout_ms:
        # A signed-out hub's panel shows placeholder cards that never load; it is not busy.
        busy = await page.evaluate('''() => Boolean(
          [...document.querySelectorAll('[data-quota-state="loading"], [aria-busy="true"]')]
            .some(e => { const panel = e.closest('[data-source-id]');
              return !panel || panel.querySelector('[data-machine="auth-files-list"]'); }) ||
          document.querySelector('header .header-actions button[aria-label="Refresh All"] svg.animate-spin, header .header-actions button[aria-label="Refresh All"][disabled]'))''')
        n = len(hubs.log)
        still = still + 200 if (n == last and not busy) else 0
        if still >= quiet_ms:
            return
        last = n
        await page.wait_for_timeout(200)
        waited += 200
    busy = await page.evaluate('''() => [...document.querySelectorAll('[data-quota-state="loading"], [aria-busy="true"]')]
      .map(e => (e.closest('[data-source-id]')?.dataset.sourceId || '?') + ' ' + (e.closest('article')?.textContent || e.textContent || '').trim().slice(0, 80))''')
    raise TimeoutError(f'page never settled: {busy}')


async def click_and_count(page, hubs, selector, out, shot, first=True):
    start = len(hubs.log)
    locator = page.locator(selector)
    await (locator.first if first else locator).click()
    await settle(page, hubs)
    await page.screenshot(path=str(out / f'{shot}.png'), full_page=False)
    return summarize(hubs.log[start:])


async def go(page, route):
    """Open a route once the post-login redirect has settled (it would undo an earlier change)."""
    await page.locator('main').wait_for()
    await page.wait_for_timeout(800)
    await page.evaluate('(hash) => { location.hash = hash; }', route)
    await page.wait_for_function('(p) => location.hash === "#" + p', arg=route)


async def notices(page):
    return await page.evaluate('''() => [...document.querySelectorAll('[class*="__notification___"]')]
      .map(e => (e.querySelector('[class*="__message___"]') || e).textContent.trim())
      .filter(Boolean)''')


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    origin = urlparse(args.url)
    if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost'):
        parser.error('Only a local HTTP server is allowed')
    base = args.url.rstrip('/')
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)
    chrome = sorted((Path.home() / '.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    report: dict = {'checks': {}, 'errors': []}
    misses: list[str] = []

    def check(name, ok, detail):
        report['checks'][name] = {'pass': bool(ok), **detail}
        if not ok:
            misses.append(name)
        print(f'{name}: {"PASS" if ok else "MISS"} {json.dumps(detail)[:400]}', flush=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=str(chrome[-1]) if chrome else None,
                                           headless=True, args=['--no-sandbox'])
        context = await browser.new_context(
            viewport={'width': 1440, 'height': 1000}, locale='en-US', timezone_id='UTC',
            color_scheme='light', reduced_motion='reduce', service_workers='block')
        hubs = fake_hub.FakeHubs('many')
        await context.route('**/*', lambda r: hubs.handle(r, origin.netloc))
        page = await context.new_page()
        page.set_default_timeout(20000)
        page.on('pageerror', lambda e: report['errors'].append(str(e)))
        await page.clock.install()
        try:
            await page.goto(f'{base}/#/login', wait_until='domcontentloaded', timeout=60000)
            await page.locator('input[type=password]').first.fill('synthetic-fixture-not-a-credential')
            await page.locator('form button[type=submit], button:has-text("Login")').first.click()
            await page.wait_for_function("location.hash.startsWith('#/quota')", timeout=30000)
            await go(page, '/auth-files')
            await page.locator('[data-source-id="alpha"] article').first.wait_for()
            await settle(page, hubs)
            everything = quota_cards(hubs)
            names = sorted(f'{s}:{a}' for s, a in everything)

            # 1. Every card, every page.
            one = await click_and_count(page, hubs, '[data-testid="auth-files-refresh-quota"]',
                                        out, '01-refresh-quota-first-click')
            check('1-first-click-reads-every-card', one['quotaCards'] == names,
                  {'expected': len(names), 'read': len(one['quotaCards']), 'calls': one['quotaCalls']})
            alpha = page.locator('[data-source-id="alpha"]')
            before_page2 = len(hubs.log)
            await alpha.get_by_role('button', name='Next').click()
            await page.wait_for_timeout(400)
            page2_states = await alpha.locator('[data-quota-state]').evaluate_all(
                '(els) => els.map(e => e.dataset.quotaState)')
            await page.screenshot(path=str(out / '02-alpha-page-2-already-read.png'))
            check('1b-second-page-already-read',
                  len(hubs.log) == before_page2 and 'idle' not in page2_states and 'loaded' in page2_states,
                  {'states': page2_states, 'requests': len(hubs.log) - before_page2})
            await alpha.get_by_role('button', name='Previous').click()

            # 2. Inside the window: nothing.
            await page.clock.fast_forward(20_000)
            two = await click_and_count(page, hubs, '[data-testid="auth-files-refresh-quota"]',
                                        out, '03-second-click-within-60s')
            label = await alpha.locator('[data-quota-state="loaded"]').first.locator(
                '[data-quota-fetched-at]').text_content()
            # Only the card whose read failed (team-b, alpha-1) is read again: failures are not kept.
            check('2-second-click-within-60s-reads-only-the-failed-card',
                  two['quotaCards'] == [FAILING],
                  {'read': two['quotaCards'], 'cardLabel': label})

            # 3. After the window: everything again.
            await page.clock.fast_forward(41_000)
            three = await click_and_count(page, hubs, '[data-testid="auth-files-refresh-quota"]',
                                          out, '04-click-after-60s')
            check('3-after-window-reads-every-card-again', three['quotaCards'] == names,
                  {'read': len(three['quotaCards']), 'expected': len(names)})

            # 4. Header: alpha's group Refresh first (alpha fresh), then 61 s for beta... use
            # 30 s so alpha's cards are still fresh and only beta's... all were read together, so
            # move 61 s and read only alpha via its group button; then the header re-reads beta.
            await page.clock.fast_forward(61_000)
            group = await click_and_count(
                page, hubs, '[data-source-id="alpha"] [data-testid="auth-files-group-refresh"]',
                out, '05-alpha-group-refresh')
            alpha_names = [n for n in names if n.startswith('alpha:')]
            check('4a-group-refresh-reads-its-cards', group['quotaCards'] == alpha_names,
                  {'read': group['quotaCards']})
            hubs.delay = 0.35
            start = len(hubs.log)
            await page.locator(HEADER_REFRESH).click()
            await page.wait_for_timeout(250)
            busy = await page.locator(HEADER_REFRESH).evaluate(
                '(b) => b.disabled || b.getAttribute("aria-busy") === "true" || !!b.querySelector("[class*=spin], [class*=loading]")')
            await page.screenshot(path=str(out / '06-header-refresh-busy.png'))
            await settle(page, hubs)
            hubs.delay = 0.02
            header = summarize(hubs.log[start:])
            shown = await notices(page)
            await page.screenshot(path=str(out / '07-header-refresh-done.png'))
            beta_names = [n for n in names if n.startswith('beta:')]
            check('4b-header-refresh-syncs-everything',
                  busy and header['credentialLists'] == {'alpha': 1, 'beta': 1}
                  and header['modelReads'] >= 4 and header['config'] >= 1
                  and header['quotaCards'] == sorted(beta_names + [FAILING]),
                  {'busyDuringRound': busy, **header, 'notices': shown})

            # 5. A revoked key on beta: one request, then nothing; the notice names the hub.
            await page.clock.fast_forward(61_000)
            hubs.denied.add('beta')
            start = len(hubs.log)
            await page.locator(HEADER_REFRESH).click()
            await settle(page, hubs)
            denied = summarize(hubs.log[start:])
            shown = await notices(page)
            await page.screenshot(path=str(out / '08-header-refresh-hub-401.png'))
            check('5-one-request-to-a-hub-that-answers-401',
                  denied['perHub']['beta'] == 1
                  and any('GPT hub fixture' in n and 'management key' in n for n in shown),
                  {'perHub': denied['perHub'], 'notices': shown})
            hubs.denied.clear()

            # 6. Quota page (a fresh context: beta's session is closed for this sign-in now).
            await context.close()
            context = await browser.new_context(
                viewport={'width': 1440, 'height': 1000}, locale='en-US', timezone_id='UTC',
                color_scheme='light', reduced_motion='reduce', service_workers='block')
            hubs = fake_hub.FakeHubs('many')
            await context.route('**/*', lambda r: hubs.handle(r, origin.netloc))
            page = await context.new_page()
            page.set_default_timeout(20000)
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            await page.clock.install()
            await page.goto(f'{base}/#/login', wait_until='domcontentloaded', timeout=60000)
            await page.locator('input[type=password]').first.fill('synthetic-fixture-not-a-credential')
            await page.locator('form button[type=submit], button:has-text("Login")').first.click()
            await page.wait_for_function("location.hash.startsWith('#/quota')", timeout=30000)
            await go(page, '/quota/accounts')
            await page.locator('main article').first.wait_for()
            await settle(page, hubs)
            refresh_all = 'main section button:has-text("Refresh all credentials")'
            start = len(hubs.log)
            buttons = page.locator(refresh_all)
            for index in range(await buttons.count()):
                await buttons.nth(index).click()
            await settle(page, hubs)
            quota_one = summarize(hubs.log[start:])
            await page.screenshot(path=str(out / '09-quota-page-refresh-all.png'), full_page=True)
            check('6a-quota-page-reads-every-card', quota_one['quotaCards'] == names,
                  {'read': len(quota_one['quotaCards']), 'expected': len(names)})
            await page.clock.fast_forward(15_000)
            start = len(hubs.log)
            for index in range(await buttons.count()):
                await buttons.nth(index).click()
            await settle(page, hubs)
            quota_two = summarize(hubs.log[start:])
            await page.screenshot(path=str(out / '10-quota-page-within-60s.png'))
            check('6b-quota-page-within-60s-reads-only-the-failed-card',
                  quota_two['quotaCards'] == [FAILING], {'read': quota_two['quotaCards']})

            # 7. Models screen, header refresh.
            await go(page, '/auth-files/models?provider=claude')
            await page.locator('[data-machine="model-inventory"][data-state="ready"]').first.wait_for()
            await settle(page, hubs)
            start = len(hubs.log)
            await page.locator(HEADER_REFRESH).click()
            await settle(page, hubs)
            models = summarize(hubs.log[start:])
            await page.screenshot(path=str(out / '11-models-header-refresh.png'))
            check('7-models-header-refresh', models['credentialLists'] == {'alpha': 1, 'beta': 1}
                  and models['modelReads'] >= 12, models)
        except Exception:
            await page.screenshot(path=str(out / 'failure.png'))
            report['failureLog'] = hubs.log[-30:]
            (out / 'counts.json').write_text(json.dumps(report, indent=2) + '\n')
            raise
        finally:
            report['unexpected'] = hubs.unexpected
            report['blocked'] = hubs.blocked
            await browser.close()
    check('no-proxied-writes-or-page-errors', not hubs.unexpected and not report['errors'],
          {'unexpected': hubs.unexpected, 'errors': report['errors'][:5]})
    (out / 'counts.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'misses': misses}), flush=True)
    return 1 if misses else 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

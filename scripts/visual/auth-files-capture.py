"""Synthetic Auth Files / Models captures against any local build of the UI.

    uv run --with playwright python -I scripts/visual/auth-files-capture.py \
        --url http://127.0.0.1:5199 --out docs/evidence/auth-files-models/after [--cases ...]

--url may be `bun run dev`, `vite preview` of the single-file build, or the deployed container on
loopback (http://127.0.0.1:18318): the UI is exercised exactly as built. fake_hub.FakeHubs answers
every management, prox and discovery request at the network layer; any other request that is not a
same-origin static asset is aborted, so no real hub, account or key is touched. Login uses a
synthetic key typed into the real form.

Each case is captured at 1440x1000 and 390x844: `fold/<case>.png` is the first viewport and
`<case>.png` the whole content (the shell scrolls inside an element, so the viewport is grown to
the content height). results.json records page errors, unexpected or blocked requests, overflow,
data-state machines on screen, and every write the page sent to the fake hubs.
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

M = '/auth-files/models?source=alpha&provider=claude'
# slug, hash route, scenario, steps. A step is (click|wait, selector), ('hub', FakeHubs method),
# ('goto', hash route), ('scroll', selector): scroll that element to its right end, or
# ('no-dialog', selector): fail the case when that element is visible, or
# ('pick-account', label): on a phone the matrix is a per-account list, so pick the account first;
# a no-op where the table shows every account, or ('sleep', ms): let delayed reads finish, or
# ('writes', [...]): fail the case unless the fake hubs received exactly these list writes, in order
# (each is (method, path, body)), or ('no-hscroll', selector): fail unless the page and that
# scroller are no wider than the viewport and their own box (checked at >= 600 px wide).
TEAM_A = 'claude-team-a.json'
TEAM_B = 'claude-team-b.json'
SAVED = '[data-machine="model-access-draft"][data-state="saved"]'
GRID = '[data-machine="model-inventory"] [role=region]'
PROVIDER = '/config/oauth/excluded-models'
FIELDS = '/credentials/fields'
# Column off for claude-haiku-4-5: team-b (own list) gets it added; everyone else follows the
# provider list, so that one write covers them (the runtime-only account included).
COLUMN_OFF_WRITES = [
    ('patch', FIELDS, {'name': TEAM_B, 'excluded_models': ['claude-3-*', 'claude-opus-4-1', 'claude-haiku-4-5']}),
    ('put', PROVIDER, {'claude': ['claude-3-*', 'claude-sonnet-4-0', 'claude-haiku-4-5']}),
]
CASES = [
    ('auth-files', '/auth-files', 'default', []),
    ('auth-files-loading', '/auth-files', 'loading', []),
    ('auth-files-empty', '/auth-files', 'empty', []),
    ('auth-files-error', '/auth-files', 'error', []),
    ('oauth-excluded-legacy', '/auth-files/oauth-excluded?source=alpha&provider=claude', 'default', []),
    ('oauth-alias-legacy', '/auth-files/oauth-model-alias?source=alpha&provider=claude', 'default', []),
    ('models', M, 'default', []),
    ('models-loading', M, 'loading', []),
    ('models-empty', M, 'empty', []),
    ('models-error', M, 'error', []),
    ('models-codex', '/auth-files/models?source=beta&provider=codex', 'default', []),
    ('models-excluded-only', M, 'default', [('click', '[data-testid="models-view-excluded"]')]),
    # One column switch: staged for every account, nothing written until Save.
    ('models-column-staged', M, 'default', [
        ('click', '[data-model-switch="claude-haiku-4-5"]'),
        ('wait', '[data-machine="model-access-draft"][data-state="pending"]'), ('writes', [])]),
    # Saved: team-b (own list) and the provider list, nothing else.
    ('models-column-saved', M, 'default', [
        ('click', '[data-model-switch="claude-haiku-4-5"]'), ('click', '[data-testid="access-save"]'),
        ('wait', SAVED), ('writes', COLUMN_OFF_WRITES),
        ('wait', '[data-model-switch="claude-haiku-4-5"][data-state="off"]')]),
    # One cell: only team-a gets a list of its own (a copy of the provider list plus the model).
    ('models-cell-saved', M, 'default', [
        ('pick-account', 'team-a@example.invalid'),
        ('click', f'[data-cell="{TEAM_A}::claude-opus-4-5"]'),
        ('wait', '[data-machine="model-access-draft"][data-state="pending"]'),
        ('click', '[data-testid="access-save"]'), ('wait', SAVED),
        ('writes', [('patch', FIELDS, {'name': TEAM_A, 'excluded_models': [
            'claude-3-*', 'claude-sonnet-4-0', 'claude-opus-4-5']})])]),
    # Turning on a model the provider wildcard covers: the bar says the rule is replaced, and only
    # team-a's new list carries the expansion.
    ('models-wildcard-on', M, 'default', [
        ('pick-account', 'team-a@example.invalid'),
        ('click', f'[data-cell="{TEAM_A}::claude-3-7-sonnet"]'), ('wait', 'text=Rule claude-3-*'),
        ('screenshot', 'pending'),
        ('click', '[data-testid="access-save"]'), ('wait', SAVED),
        ('writes', [('patch', FIELDS, {'name': TEAM_A, 'excluded_models': [
            'claude-3-5-haiku', 'claude-sonnet-4-0']})])]),
    # Discard: the staged switches go, nothing is written.
    ('models-discard', M, 'default', [
        ('click', '[data-model-switch="claude-haiku-4-5"]'), ('click', '[data-testid="access-discard"]'),
        ('no-dialog', '[data-testid="access-save-bar"]'),
        ('wait', '[data-model-switch="claude-haiku-4-5"][data-state="on"]'), ('writes', [])]),
    # The runtime-only account forces a non-empty provider list, so team-a cannot have every
    # model on: Save is blocked with the reason, nothing is written.
    ('models-blocked', M, 'default', [
        ('pick-account', 'team-a@example.invalid'),
        ('click', f'[data-account-switch="{TEAM_A}"]'),
        ('wait', '[data-machine="model-access-draft"][data-state="blocked"]'),
        ('wait', '[data-testid="access-save"]:disabled'), ('writes', [])]),
    ('models-many-accounts', M, 'many', []),
    # 21 models: the table scrolls sideways under a sticky account column and model header.
    ('models-wide', M, 'wide', []),
    # Models are rows and accounts share the width: neither the page nor the table scrolls sideways.
    ('models-fit-default', M, 'default', [('no-hscroll', GRID)]),
    ('models-fit-wide', M, 'wide', [('no-hscroll', GRID)]),
    # No ?source=: every hub with Claude accounts gets its own section under the one Claude tab.
    ('models-all-sources', '/auth-files/models?provider=claude', 'shared', []),
    ('models-rules', M + '&tab=rules', 'default', []),
    ('models-aliases', M + '&tab=aliases', 'default', []),
    # One button loads quota for every card shown; one account's read fails and says so in place.
    ('auth-files-quota-refreshed', '/auth-files', 'default', [
        ('click', '[data-testid="auth-files-refresh-quota"]'),
        ('wait', '[data-quota-state="loaded"]'), ('wait', '[data-quota-state="failed"]')]),
    # The alpha group's own Refresh: one click, no dialog, quota loaded with Account details open.
    ('auth-files-group-refresh', '/auth-files', 'default', [
        ('click', '[data-source-id="alpha"] [data-testid="auth-files-group-refresh"]'),
        ('wait', '[data-quota-state="loaded"]'), ('wait', '[data-quota-state="loaded"] details[open]'),
        ('no-dialog', '[role=dialog]')]),
    # A rate-limited card says when the hub retries it (next_retry_after), not "try again later".
    ('auth-files-rate-limited', '/auth-files', 'rate-limited', [('wait', 'text=retry after')]),
    ('auth-files-group-menu', '/auth-files', 'default', [
        ('click', '[data-source-id="alpha"] [aria-haspopup="menu"]')]),
    # Six Claude cards whose quota windows, billing text and held resets all differ: in every grid row
    # each section, quota row, Billing block and Manual resets box must start at the same height.
    ('auth-files-card-alignment', '/auth-files', 'aligned', [
        ('click', '[data-source-id="alpha"] [data-testid="auth-files-group-refresh"]'),
        ('wait', '[data-quota-state="loaded"] details[open]'), ('sleep', '4500')]),
    # team-b's write fails, the provider list lands: the bar and team-b's row say so, and team-b's
    # switch stays staged for another Save.
    ('models-partial-failure', M, 'partial', [
        ('click', '[data-model-switch="claude-haiku-4-5"]'), ('click', '[data-testid="access-save"]'),
        ('wait', '[data-machine="model-access-draft"][data-state="failed"]'),
        ('writes', COLUMN_OFF_WRITES), ('pick-account', 'team-b@example.invalid'),
        ('wait', '[data-marker="failed"]'),
        ('wait', f'[data-cell="{TEAM_B}::claude-haiku-4-5"][data-changed="true"]')]),
    # The same store feeds the dialog and the credential sheet on Auth Files.
    ('auth-files-models-dialog', '/auth-files', 'default', [
        ('click', '[data-source-id="alpha"] [data-card-models="claude-team-b.json"]'),
        ('wait', '[role=dialog] [data-machine="model-inventory"][data-state="ready"]')]),
    ('auth-files-sheet-exclusions', '/auth-files', 'default', [
        ('click', '[data-source-id="alpha"] [data-card-settings="claude-team-a.json"]'),
        ('wait', '[data-list="inherits"]')]),
    # Auth Files first, then Models in the same session: the provider lists are not fetched twice.
    ('models-after-auth-files', '/auth-files', 'default', [
        ('goto', M), ('wait', '[data-machine="model-inventory"][data-state="ready"]')]),
    # Another operator edits the provider list after the page read it: nothing is written.
    ('models-stale', M, 'default', [
        ('click', '[data-model-switch="claude-sonnet-4-5"]'), ('hub', 'edit_elsewhere'),
        ('click', '[data-testid="access-save"]'),
        ('wait', '[data-machine="model-access-draft"][data-state="stale"]'), ('writes', [])]),
]

MEASURE = '''() => {
  const main=document.querySelector('main');
  const clipped=(e)=>{for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){
    const o=getComputedStyle(p).overflowX;if(o==='auto'||o==='scroll'||o==='hidden') return true;}return false;};
  return {
    headings:[...(main?.querySelectorAll('h1,h2,h3')||[])].map(e=>e.textContent.trim()).slice(0,24),
    alerts:[...(main?.querySelectorAll('[role=alert]')||[])].map(e=>e.textContent.trim()).filter(Boolean),
    states:[...document.querySelectorAll('[data-machine][data-state]')].map(e=>e.dataset.machine+'='+e.dataset.state),
    overflow:document.documentElement.scrollWidth>innerWidth+1,
    overflowElements:[...(main?.querySelectorAll('*')||[])].filter(e=>{const r=e.getBoundingClientRect();
      return r.width>0&&(r.right>innerWidth+1||r.left< -1)&&getComputedStyle(e).position!=='fixed'&&!clipped(e);})
      .slice(0,8).map(e=>({tag:e.tagName,class:String(e.className).slice(0,80)})),
    hash:location.hash,
    gridScrollsSideways:[...document.querySelectorAll('[data-machine="model-inventory"] [role=region]')]
      .some(e=>e.scrollWidth>e.clientWidth+1),
  };
}'''
# Cards of one grid row, section by section: the top of each section, quota row and account-details
# block must not differ by more than 1px between cards. A card that lacks a section the others show
# is a finding when `strict` (the 'aligned' scenario reads every card fully, so none may lack one).
ALIGNMENT = '''(strict) => {
  const TOL = 1;
  // Sections are found by their CSS-module class (generateScopedName keeps `__local___`), rows by
  // their label, so the same measurement runs against any build, before or after a change.
  const q = (root, local) => root.querySelector(`[class*="__${local}___"]`);
  const cards = [...document.querySelectorAll('main article')].filter(c => q(c, 'head'));
  const top = (e) => Math.round(e.getBoundingClientRect().top * 10) / 10;
  const SLOTS = {head: 'head', account: 'identityLine', requests: 'health', meta: 'metaRow',
                 quota: 'quotaSection', footer: 'actions'};
  const measure = (card) => {
    const m = {};
    for (const [key, local] of Object.entries(SLOTS)) {
      const e = q(card, local);
      if (e) m[key] = top(e);
    }
    const quota = q(card, 'quotaSection');
    if (quota) {
      m['quota-head'] = top(q(quota, 'quotaHead'));
      const rows = [...quota.querySelectorAll('[class*="__quotaRow___"]')]
        .filter(e => getComputedStyle(e).display !== 'none');
      rows.forEach(e => { m['row:' + q(e, 'quotaModel').textContent.trim()] = top(e); });
      const chip = q(quota, 'codexPlan');
      if (chip) m['plan-chip'] = top(chip);
      const summary = quota.querySelector('details > summary');
      if (summary) m['details-summary'] = top(summary);
      ['billing', 'resets', 'balances'].forEach((name, i) => {
        const section = quota.querySelectorAll('details section')[i];
        if (section) m[name] = top(section);
      });
    }
    m['card-bottom'] = Math.round(card.getBoundingClientRect().bottom * 10) / 10;
    return m;
  };
  const bands = [];
  for (const card of cards.sort((a, b) => top(a) - top(b))) {
    const band = bands.find(b => Math.abs(top(b[0]) - top(card)) <= TOL);
    band ? band.push(card) : bands.push([card]);
  }
  const rowed = bands.filter(b => b.length > 1);
  const violations = [];
  let maxDelta = 0, compared = 0;
  const optional = new Set(['balances']);
  rowed.forEach((band, i) => {
    const maps = band.map(measure);
    const keys = new Set(maps.flatMap(m => Object.keys(m)));
    for (const key of keys) {
      const present = maps.filter(m => key in m).map(m => m[key]);
      if (strict && present.length < maps.length && !optional.has(key))
        violations.push({band: i, key, problem: 'missing on ' + (maps.length - present.length) + ' card(s)'});
      if (present.length < 2) continue;
      compared += 1;
      const delta = Math.round((Math.max(...present) - Math.min(...present)) * 10) / 10;
      maxDelta = Math.max(maxDelta, delta);
      if (delta > TOL) violations.push({band: i, key, problem: 'tops differ by ' + delta + 'px', tops: present});
    }
  });
  if (strict && !rowed.length) violations.push({key: 'grid', problem: 'no grid row holds two cards'});
  return {cards: cards.length, bands: rowed.length, compared, maxDelta, violations: violations.slice(0, 16)};
}'''
# Sideways scroll of the page and of one scroller, with the widths that decide it.
HSCROLL = '''(e) => ({
  page: document.documentElement.scrollWidth > innerWidth + 1,
  table: e.scrollWidth > e.clientWidth + 1,
  scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, viewport: innerWidth,
  columns: e.querySelectorAll('thead th').length - 1,
})'''
CONTENT_HEIGHT = '''() => Math.max(innerHeight, document.documentElement.scrollHeight,
  ...[...document.querySelectorAll('*')]
  .filter(e=>e.scrollHeight>e.clientHeight+4&&getComputedStyle(e).overflowY!=='visible')
  .map(e=>e.scrollHeight+Math.max(0,e.getBoundingClientRect().top)))'''


async def login(page, base):
    await page.goto(f'{base}/#/login', wait_until='domcontentloaded', timeout=60000)
    await page.locator('input[type=password]').first.fill('synthetic-fixture-not-a-credential', timeout=30000)
    await page.locator('form button[type=submit], button:has-text("Login")').first.click()
    # Login lands on #/ and then redirects to #/quota; navigate only after that settles.
    await page.wait_for_function("location.hash.startsWith('#/quota')", timeout=30000)
    await page.locator('main').wait_for()


async def run_case(browser, base, origin, out, width, case):
    slug, route, scenario, steps = case
    name = f'{slug}-{width}'
    height = 1000 if width >= 600 else 844
    context = await browser.new_context(
        viewport={'width': width, 'height': height}, is_mobile=width < 600, has_touch=width < 600,
        locale='en-US', timezone_id='UTC', color_scheme='light', reduced_motion='reduce',
        service_workers='block')
    hubs = fake_hub.FakeHubs(scenario)
    await context.route('**/*', lambda r: hubs.handle(r, origin.netloc))
    page = await context.new_page()
    page.set_default_timeout(20000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    result = {}
    extra = {}
    try:
        await login(page, base)
        await page.evaluate('(hash) => { location.hash = hash; }', route)
        path = route.split('?')[0]
        await page.wait_for_function('(p) => location.hash.split("?")[0] === "#" + p || '
                                     'location.hash.startsWith("#/auth-files")', arg=path)
        await page.locator('main').wait_for()
        await page.wait_for_timeout(1500)
        for action, selector in steps:
            if action == 'click':
                await page.locator(selector).first.click()
                await page.wait_for_timeout(600)
            elif action == 'no-dialog':
                if await page.locator(selector).first.is_visible():
                    raise AssertionError(f'unexpected dialog: {selector}')
            elif action == 'sleep':
                await page.wait_for_timeout(int(selector))
            elif action == 'hub':
                getattr(hubs, selector)()
            elif action == 'pick-account':
                picker = page.locator('[data-layout="list"] [aria-haspopup="listbox"]')
                if await picker.count():
                    await picker.first.click()
                    await page.locator(f'[role=option]:has-text("{selector}")').first.click()
                    await page.wait_for_timeout(300)
            elif action == 'scroll':
                target = page.locator(selector)
                if await target.count():
                    await target.first.evaluate('(e) => { e.scrollLeft = e.scrollWidth; }')
                    await page.wait_for_timeout(300)
            elif action == 'writes':
                sent = [(w['method'], w['path'], w['body']) for w in hubs.writes
                        if w['path'] in (FIELDS, PROVIDER)]
                if sent != [tuple(item) for item in selector]:
                    raise AssertionError(f'writes: expected {selector}, got {sent}')
            elif action == 'no-hscroll':
                if width >= 600:
                    fit = await page.locator(selector).first.evaluate(HSCROLL)
                    extra['hscroll'] = fit
                    if fit['page'] or fit['table']:
                        raise AssertionError(f'horizontal scroll: {fit}')
            elif action == 'screenshot':
                await page.screenshot(path=str(out / 'fold' / f'{name}-{selector}.png'), timeout=30000)
            elif action == 'goto':
                await page.evaluate('(hash) => { location.hash = hash; }', selector)
                await page.wait_for_timeout(600)
            else:
                await page.locator(selector).first.wait_for(timeout=20000)
                await page.wait_for_timeout(300)
        result = await page.evaluate(MEASURE)
        result.update(extra)
        # Phones show one card per row, so there is nothing to line up there.
        result['alignment'] = await page.evaluate(ALIGNMENT, scenario == 'aligned' and width >= 600)
        await page.screenshot(path=str(out / 'fold' / f'{name}.png'), timeout=30000)
        content = await page.evaluate(CONTENT_HEIGHT)
        await page.set_viewport_size({'width': width, 'height': min(int(content) + 120, 9000)})
        await page.wait_for_timeout(400)
        await page.screenshot(path=str(out / f'{name}.png'), timeout=30000)
    except Exception as error:  # noqa: BLE001 - every harness failure is a finding
        result['harnessError'] = str(error).splitlines()[0]
        try:
            await page.screenshot(path=str(out / f'{name}-failure.png'), timeout=15000)
        except Exception:  # noqa: BLE001
            pass
    result.update(errors=errors, route=route, scenario=scenario, writes=hubs.writes,
                  credentialReads=hubs.credential_reads, reads=hubs.reads,
                  unexpected=hubs.unexpected, blocked=hubs.blocked)
    result['pass'] = not any(result.get(k) for k in
                             ['overflow', 'errors', 'blocked', 'harnessError', 'unexpected']) \
        and not result.get('alignment', {}).get('violations')
    await context.close()
    return name, result


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://127.0.0.1:5199')
    parser.add_argument('--out', required=True)
    parser.add_argument('--cases', nargs='*')
    parser.add_argument('--widths', nargs='*', type=int, default=[1440, 390])
    args = parser.parse_args()
    origin = urlparse(args.url)
    if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost'):
        parser.error('Only a local HTTP server is allowed')
    base = args.url.rstrip('/')
    out = ROOT / args.out
    (out / 'fold').mkdir(parents=True, exist_ok=True)
    chrome = sorted((Path.home() / '.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    report = {'url': base, 'cases': {}}
    results_path = out / 'results.json'
    if results_path.exists() and args.cases:
        report['cases'] = json.loads(results_path.read_text()).get('cases', {})
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=str(chrome[-1]) if chrome else None,
                                           headless=True, args=['--no-sandbox'])
        try:
            for width in args.widths:
                for case in CASES:
                    if args.cases and case[0] not in args.cases:
                        continue
                    name, result = await run_case(browser, base, origin, out, width, case)
                    report['cases'][name] = result
                    results_path.write_text(json.dumps(report, indent=2) + '\n')
                    print(f'{name}: {"PASS" if result["pass"] else "FINDING"}', flush=True)
        finally:
            await browser.close()
    findings = [n for n, v in report['cases'].items() if not v['pass']]
    print(json.dumps({'cases': len(report['cases']), 'findings': findings}), flush=True)
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

"""Keyboard and accessible-name checks for the Models screen (fake hub; local server only).

    uv run --with playwright python -I -B scripts/visual/models-keyboard-check.py --url http://127.0.0.1:5199

Prints one JSON object with a pass flag per check; exits 1 when any check fails.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fake_hub = load('fake_hub', 'fake_hub.py')
capture = load('auth_files_capture', 'auth-files-capture.py')
ACTIVE = "(() => { const e = document.activeElement; return e ? (e.dataset.cell || e.dataset.modelSwitch || e.id || e.textContent.trim().slice(0, 40)) : null; })()"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:5199')
    args = parser.parse_args()
    base = args.url.rstrip('/')
    origin = urlparse(base)
    chrome = sorted((Path.home() / '.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    results = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=str(chrome[-1]) if chrome else None,
                                           headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='en-US',
                                            reduced_motion='reduce')
        hubs = fake_hub.FakeHubs('default')
        await context.route('**/*', lambda r: hubs.handle(r, origin.netloc))
        page = await context.new_page()
        page.set_default_timeout(20000)
        await capture.login(page, base)
        await page.evaluate("location.hash = '/auth-files/models?source=alpha&provider=claude'")
        await page.locator('[data-machine="model-inventory"][data-state="ready"]').wait_for()

        cell = page.locator('[data-cell="claude-team-a.json::claude-opus-4-5"]')
        bar = page.locator('[data-machine="model-access-draft"]')

        # 1. A cell is a named switch: model, account and on/off are all exposed.
        role, checked, label = await cell.evaluate(
            "e => [e.getAttribute('role'), e.getAttribute('aria-checked'), e.getAttribute('aria-label')]")
        results['cellIsNamedSwitch'] = {
            'pass': role == 'switch' and checked == 'true' and label
            and 'claude-opus-4-5' in label and 'team-a@example.invalid' in label,
            'role': role, 'checked': checked, 'label': label}

        # 2. Space on a focused cell stages it (no dialog, nothing written); focus stays on it.
        await cell.focus()
        await page.keyboard.press('Space')
        await bar.wait_for()
        checked = await cell.get_attribute('aria-checked')
        changed = await cell.get_attribute('data-changed')
        dialogs = await page.get_by_role('dialog').count()
        active = await page.evaluate(ACTIVE)
        results['spaceStagesWithoutDialog'] = {
            'pass': checked == 'false' and changed == 'true' and dialogs == 0 and not hubs.writes
            and active == 'claude-team-a.json::claude-opus-4-5',
            'checked': checked, 'changed': changed, 'dialogs': dialogs, 'active': active}

        # 3. Enter flips it back; the change is gone and so is the bar.
        await page.keyboard.press('Enter')
        await bar.wait_for(state='detached')
        results['enterUnstages'] = {'pass': await cell.get_attribute('aria-checked') == 'true'}

        # 4. A model's switch is a tri-state checkbox: one cell off makes it mixed.
        column = page.locator('[data-model-switch="claude-opus-4-5"]')
        await cell.focus()
        await page.keyboard.press('Space')
        mixed = await column.get_attribute('aria-checked')
        name = await column.get_attribute('aria-label')
        await column.focus()
        await page.keyboard.press('Space')
        after = await column.get_attribute('aria-checked')
        results['columnSwitchTriState'] = {
            'pass': mixed == 'mixed' and after == 'true' and name == 'claude-opus-4-5 on every account',
            'mixed': mixed, 'after': after, 'label': name}

        # 5. Save and Discard are reachable and work from the keyboard.
        await cell.focus()
        await page.keyboard.press('Space')
        await page.locator('[data-testid="access-save"]').focus()
        await page.keyboard.press('Enter')
        await page.locator('[data-machine="model-access-draft"][data-state="saved"]').wait_for()
        sent = [(w['method'], w['path'], w['body']) for w in hubs.writes]
        results['saveByKeyboard'] = {
            'pass': sent == [('patch', '/credentials/fields', {
                'name': 'claude-team-a.json',
                'excluded_models': ['claude-3-*', 'claude-sonnet-4-0', 'claude-opus-4-5']})],
            'writes': sent}

        # 6. Arrow keys move between tabs (roving tabindex).
        await page.locator('#models-tab-access').focus()
        await page.keyboard.press('ArrowRight')
        await page.wait_for_timeout(300)
        selected = await page.locator('[role=tab][aria-selected=true]').get_attribute('id')
        focused = await page.evaluate('document.activeElement?.id')
        results['arrowKeysMoveTabs'] = {'pass': selected == 'models-tab-rules' and focused == 'models-tab-rules',
                                        'selected': selected, 'focused': focused}
        await page.keyboard.press('ArrowLeft')
        await page.locator('[data-machine="model-inventory"][data-state="ready"]').wait_for()

        # 7. Every interactive control in the grid has an accessible name.
        unnamed = await page.evaluate('''() => [...document.querySelectorAll('table button, table [role=img]')]
          .filter(e => !(e.getAttribute('aria-label') || e.textContent.trim()))
          .map(e => e.outerHTML.slice(0, 80))''')
        results['gridControlsNamed'] = {'pass': not unnamed, 'unnamed': unnamed[:5]}

        # 8. Reduced motion: no running CSS transitions on the provider tabs or the switches.
        durations = await page.evaluate("""[
          getComputedStyle(document.querySelector('[role=group][aria-label=Provider] button')).transitionDuration,
          getComputedStyle(document.querySelector('[data-cell]')).transitionDuration]""")
        results['reducedMotion'] = {'pass': all(d in ('0s', '') for d in durations),
                                    'transitionDuration': durations}
        await browser.close()
    ok = all(value['pass'] for value in results.values())
    print(json.dumps({'pass': ok, 'checks': results}, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

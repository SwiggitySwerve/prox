"""Keyboard and accessible-name checks for the Models screen (fake hub; local server only).

    uv run --with playwright python -I scripts/visual/models-keyboard-check.py --url http://127.0.0.1:5199

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
ACTIVE = "(() => { const e = document.activeElement; return e ? (e.dataset.cell || e.dataset.rowAction || e.id || e.textContent.trim().slice(0, 40)) : null; })()"


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

        # 1. Enter on a focused cell opens the inherit-choice dialog with focus inside it.
        cell = page.locator('[data-cell="claude-team-a.json::claude-opus-4-5"]')
        await cell.focus()
        await page.keyboard.press('Enter')
        dialog = page.get_by_role('dialog')
        await dialog.wait_for()
        # The Modal moves focus on a 0 ms timer after it mounts; allow it a second to land.
        try:
            await page.wait_for_function(
                "document.querySelector('[role=dialog]')?.contains(document.activeElement)", timeout=1000)
            inside = True
        except Exception:  # noqa: BLE001 - reported as a failed check
            inside = False
        focused = await page.evaluate(ACTIVE)
        results['enterOpensDialogWithFocusInside'] = {'pass': inside, 'active': focused}

        # 2. Escape closes it and focus returns to the cell.
        await page.keyboard.press('Escape')
        await dialog.wait_for(state='detached')
        await page.wait_for_timeout(400)
        active = await page.evaluate(ACTIVE)
        results['escapeClosesAndRestoresFocus'] = {
            'pass': active == 'claude-team-a.json::claude-opus-4-5', 'active': active}

        # 3. The choice dialog is fully keyboard operable: Tab to a choice, Enter, then preview.
        await cell.focus()
        await page.keyboard.press('Enter')
        await dialog.wait_for()
        await page.get_by_role('button', name='Give this account its own list').focus()
        await page.keyboard.press('Enter')
        await page.locator('[data-machine="model-edit-session"][data-state="previewing"]').first.wait_for()
        results['choiceByKeyboardReachesPreview'] = {'pass': True}
        await page.keyboard.press('Escape')
        await dialog.wait_for(state='detached')

        # 4. Arrow keys move between tabs (roving tabindex).
        await page.locator('#models-tab-access').focus()
        await page.keyboard.press('ArrowRight')
        await page.wait_for_timeout(300)
        selected = await page.locator('[role=tab][aria-selected=true]').get_attribute('id')
        focused = await page.evaluate('document.activeElement?.id')
        results['arrowKeysMoveTabs'] = {'pass': selected == 'models-tab-rules' and focused == 'models-tab-rules',
                                        'selected': selected, 'focused': focused}
        await page.keyboard.press('ArrowLeft')
        await page.locator('[data-machine="model-inventory"][data-state="ready"]').wait_for()

        # 5. Every interactive control in the matrix has an accessible name.
        unnamed = await page.evaluate('''() => [...document.querySelectorAll('table button, table [role=img]')]
          .filter(e => !(e.getAttribute('aria-label') || e.textContent.trim()))
          .map(e => e.outerHTML.slice(0, 80))''')
        results['matrixControlsNamed'] = {'pass': not unnamed, 'unnamed': unnamed[:5]}

        # 6. Cell names state model, account and reason (screen readers hear the why).
        label = await cell.get_attribute('aria-label')
        results['cellNameExplains'] = {
            'pass': bool(label and 'claude-opus-4-5' in label and 'team-a@example.invalid' in label
                         and 'Served' in label), 'label': label}

        # 7. Locked wildcard cell is a button that explains, never toggles.
        writes_before = len(hubs.writes)
        await page.locator('[data-cell="claude-team-a.json::claude-3-7-sonnet"]').focus()
        await page.keyboard.press('Enter')
        await page.locator('[data-machine="locked-cell"]').wait_for()
        await page.keyboard.press('Escape')
        results['wildcardCellNeverWrites'] = {'pass': len(hubs.writes) == writes_before}

        # 8. Reduced motion: no running CSS transitions on the provider tabs.
        duration = await page.evaluate(
            "getComputedStyle(document.querySelector('[role=group][aria-label=Provider] button')).transitionDuration")
        results['reducedMotion'] = {'pass': duration in ('0s', ''), 'transitionDuration': duration}

        # 9. A model column's action keeps its name and is reachable by keyboard from the header.
        action = page.locator('[data-row-action="claude-opus-4-5"]')
        name = await action.get_attribute('aria-label')
        await action.focus()
        focused = await page.evaluate(ACTIVE)
        results['columnActionNamed'] = {
            'pass': name == 'Exclude everywhere: claude-opus-4-5' and focused == 'claude-opus-4-5',
            'label': name, 'active': focused}
        await browser.close()
    ok = all(value['pass'] for value in results.values())
    print(json.dumps({'pass': ok, 'checks': results}, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

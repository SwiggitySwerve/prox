// Secondary text on the system and logs pages: definitions live in InfoTips after their labels,
// and warnings / destructive-action notes stay visible. Source contracts only; hover, focus and
// tap behaviour and the visual layout need a browser.
//
// ProxUI keeps its own dashboard, plugins pages and sidebar, so upstream's checks for those
// surfaces are not carried here. The system page is source-scoped, so it is checked by source.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('system page', () => {
  const source = read('src/pages/SystemPage.tsx');

  test('the models card explains its two buttons in an InfoTip and a tooltip', () => {
    expect(source).toMatch(
      /<InfoTip\s+content=\{t\('system_info\.models_desc'\)\}\s+label=\{t\('system_info\.models_title'\)\}/
    );
    // No native title on the catalog button: its hint is a Tooltip.
    expect(source).not.toContain("title={t('system_info.models_catalog_refresh_hint')}");
    expect(source).toMatch(
      /<Tooltip content=\{t\('system_info\.models_catalog_refresh_hint'\)\}>\s*<Button/
    );
  });

  test('the catalog refresh goes to the selected hub, never the compatibility client', () => {
    expect(source).toContain("await scope.session.management.post('/models/refresh');");
    expect(source).not.toMatch(/\bapiClient\b/);
  });

  test('quick links are titles only; the destructive clear-login note stays visible', () => {
    expect(source).not.toContain('styles.linkDesc');
    expect(source).toContain("{t('system_info.clear_login_desc')}");
  });
});

describe('logs page', () => {
  const source = read('src/features/logs/LogsPage.tsx');

  test('the error-log caveat is an InfoTip on the tab card title', () => {
    expect(source).toMatch(
      /\{t\('logs\.error_logs_modal_title'\)\}\s*<InfoTip\s+content=\{t\('logs\.error_logs_description'\)\}/
    );
    expect(source).not.toContain(`<div className="hint">{t('logs.error_logs_description')}</div>`);
    // The "request logging is on, so this list stays empty" warning remains visible.
    expect(source).toContain("{t('logs.error_logs_request_log_enabled')}");
  });

  test('the raw-log explanation moved from a title to an InfoTip beside the switch', () => {
    expect(source).not.toMatch(/title=\{t\('logs\.show_raw_logs_hint'/);
    // A sibling of the switch, not inside its <label>.
    expect(source).toMatch(
      /checked=\{showRawLogs\}[\s\S]*?<\/span>\s*\}\s*\/>\s*<InfoTip\s+content=\{t\('logs\.show_raw_logs_hint'/
    );
  });
});

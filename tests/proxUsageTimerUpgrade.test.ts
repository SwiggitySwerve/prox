import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(mode: 'enabled' | 'missing' | 'failure') {
  const root = mkdtempSync('/dev/shm/prox-timer-upgrade-');
  roots.push(root);
  const units = join(root, '.config/systemd/user');
  const wants = join(units, 'timers.target.wants');
  const defaultWants = join(units, 'default.target.wants');
  const bin = join(root, 'bin');
  mkdirSync(wants, { recursive: true });
  mkdirSync(defaultWants);
  mkdirSync(bin);
  for (const kind of ['prune', 'reconcile', 'backup', 'parity']) {
    const name = `prox-usage-${kind}.timer`;
    if (mode !== 'missing') writeFileSync(join(units, name), '[Timer]\n');
    symlinkSync(`../${name}`, join(wants, name));
  }
  // The janitor's retired path watcher is wanted by default.target, not timers.target.
  if (mode !== 'missing') writeFileSync(join(units, 'prox-auth-janitor.path'), '[Path]\n');
  symlinkSync('../prox-auth-janitor.path', join(defaultWants, 'prox-auth-janitor.path'));
  writeFileSync(join(units, 'prox-auth-janitor.timer'), '[Timer]\n');
  symlinkSync('../prox-auth-janitor.timer', join(wants, 'prox-auth-janitor.timer'));
  writeFileSync(join(units, 'unrelated.timer'), '[Timer]\n');
  symlinkSync('../unrelated.timer', join(wants, 'unrelated.timer'));
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh
set -eu
test "$1" = --user
test "$2" = disable
test "$3" = --now
printf '%s\\n' "$4" >> "$HOME/calls"
case "$UPGRADE_TEST_MODE" in
  missing) echo "Unit $4 not loaded" >&2; exit 1 ;;
  failure) echo 'Failed to connect to user manager: Permission denied' >&2; exit 1 ;;
esac
# The real disable removes enable links; verify retirement precedes unit deletion.
test -f "$HOME/.config/systemd/user/$4"
rm -f "$HOME/.config/systemd/user/timers.target.wants/$4" "$HOME/.config/systemd/user/default.target.wants/$4"
`,
    { mode: 0o700 }
  );
  const script = readFileSync('scripts/deploy-homelab.sh', 'utf8');
  const start = script.indexOf('# Retire units no longer shipped');
  const end = script.indexOf('systemctl --user daemon-reload', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const result = Bun.spawnSync(['/bin/bash', '-euc', script.slice(start, end)], {
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      UPGRADE_TEST_MODE: mode,
    },
  });
  return { root, units, wants, defaultWants, result };
}
test('upgrade disables enabled retired units and removes units and enable symlinks before reload', () => {
  const f = fixture('enabled');
  expect(f.result.exitCode).toBe(0);
  expect(readFileSync(join(f.root, 'calls'), 'utf8').trim().split('\n')).toEqual([
    ...['prune', 'reconcile', 'backup', 'parity'].map((kind) => `prox-usage-${kind}.timer`),
    'prox-auth-janitor.path',
  ]);
  // The janitor's timer (still shipped) and unrelated units are untouched.
  expect(readdirSync(f.units).sort()).toEqual([
    'default.target.wants',
    'prox-auth-janitor.timer',
    'timers.target.wants',
    'unrelated.timer',
  ]);
  expect(readdirSync(f.wants).sort()).toEqual(['prox-auth-janitor.timer', 'unrelated.timer']);
  expect(readdirSync(f.defaultWants)).toEqual([]);
});
test('retirement tolerates not-loaded timers and clears their dangling enable links', () => {
  const f = fixture('missing');
  expect(f.result.exitCode).toBe(0);
  expect(readdirSync(f.wants).sort()).toEqual(['prox-auth-janitor.timer', 'unrelated.timer']);
  expect(readdirSync(f.defaultWants)).toEqual([]);
});
test('retirement stops on manager failures without deleting the still-enabled unit', () => {
  const f = fixture('failure');
  expect(f.result.exitCode).not.toBe(0);
  expect(existsSync(join(f.units, 'prox-usage-prune.timer'))).toBe(true);
  expect(readdirSync(f.wants)).toContain('prox-usage-prune.timer');
});

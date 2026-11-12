/**
 * The app shell reads each hub's plugin list for the sidebar. The hub reports plugin support in a
 * response header, which publishes a new source registry mid-load; that update must not start a
 * second read of every hub's list. An explicit refresh still reads them again.
 */
import { expect, test } from './credentialFlowHarness';

const READS = ['/claude/v8/management/plugins', '/codex/v8/management/plugins'];

test('each hub plugin list is read once per page load, and again on an explicit refresh', async ({
  flow,
  context,
}) => {
  flow.pluginSupport = true;
  const page = await flow.open(context, '/dashboard');
  await expect
    .poll(() => flow.pluginRequests.length, { message: 'both hubs are read' })
    .toBeGreaterThanOrEqual(2);
  // Let late registry updates (version and plugin-support headers) land and any reload start.
  await page.waitForTimeout(2500);
  expect([...flow.pluginRequests].sort()).toEqual(READS);

  await page.evaluate(() => window.dispatchEvent(new Event('plugin-resources-refresh')));
  await expect.poll(() => flow.pluginRequests.length).toBe(4);
  expect([...flow.pluginRequests].sort()).toEqual([...READS, ...READS].sort());
});

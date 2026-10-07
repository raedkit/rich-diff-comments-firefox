/**
 * E2E: touch input on the ADO Preview (Firefox for Android / any hover:none
 * device).
 *
 * Emulates a Pixel 7 so `@media (hover: none)` matches and pointers are
 * touch. Covers what the mouse suites can't:
 *   • the + is visible without hover
 *   • one tap on the + opens the single-line comment box
 *   • dragging a + onto another + opens a range box
 *   • dragging the sidebar header moves the sidebar
 *
 * Chromium only: Playwright's Firefox has no isMobile / hover:none
 * emulation and no CDP touch input.
 */
const { test, expect, devices } = require('@playwright/test');
const { setupAdoExtensionPage } = require('./_helpers');

// `defaultBrowserType` can't be set from inside a spec file; the project
// already decides the browser.
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7'];
test.use(pixel7);
test.skip(({ browserName }) => browserName === 'firefox',
  'Playwright Firefox has no isMobile / hover:none emulation and no CDP touch input');

async function centerOf(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A real touch drag: touchstart -> several touchmoves -> touchend, injected
// through CDP so the page sees pointerType "touch" with implicit capture.
async function touchDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const point = (p) => [{ x: p.x, y: p.y, id: 0 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('ADO touch input', () => {
  test.beforeEach(async ({ page }) => {
    await setupAdoExtensionPage(page);
    // Fixtures have no viewport meta; without it mobile emulation lays out
    // at 980px and touch coordinates no longer match layout coordinates.
    await page.evaluate(() => {
      const meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1';
      document.head.appendChild(meta);
    });
  });

  const startHost = (page) => page.locator('.markdown-preview-container p', { hasText: 'The worker uses a durable queue.' });
  const endHost = (page) => page.locator('.markdown-preview-container li', { hasText: 'Retry failed work' });

  test('the + is visible without hover and has a finger-sized target', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const btn = startHost(page).locator('.adrc-comment-btn');
    await expect(btn).toHaveCSS('opacity', '0.6');
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
  });

  // The desktop-sized fixture leaves the floating sidebar on top of the
  // narrow preview column; clear it so touches reach the + buttons.
  const hideSidebar = (page) => page.evaluate(() => {
    document.querySelectorAll('.adrc-sidebar, .adrc-sidebar-launcher').forEach((el) => { el.style.display = 'none'; });
  });

  test('one tap on the + opens a single-line comment box', async ({ page }) => {
    await hideSidebar(page);
    const host = endHost(page);
    await host.scrollIntoViewIfNeeded();
    const point = await centerOf(host.locator('.adrc-comment-btn'));
    await page.touchscreen.tap(point.x, point.y);

    const editor = page.locator('.adrc-compose-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.adrc-editor-header')).toContainText(':9');
    await expect(editor.locator('.adrc-line-input-start')).toHaveCount(0);
  });

  test('dragging a + onto another + opens a range comment box', async ({ page }) => {
    await hideSidebar(page);
    // Both ends must be on screen at once: the narrow column wraps the
    // paragraph tall, so put the start + at the top of the viewport.
    await startHost(page).locator('.adrc-comment-btn').evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
    });
    const from = await centerOf(startHost(page).locator('.adrc-comment-btn'));
    const to = await centerOf(endHost(page).locator('.adrc-comment-btn'));

    await touchDrag(page, from, to);

    const editor = page.locator('.adrc-compose-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.adrc-line-input-start')).toHaveValue('7');
    await expect(editor.locator('.adrc-line-input-end')).toHaveValue('9');
  });

  test('dragging the sidebar header moves the sidebar', async ({ page }) => {
    const sidebar = page.locator('.adrc-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.evaluate((el) => { el.style.left = '40px'; el.style.top = '40px'; });
    const before = await sidebar.boundingBox();
    // Left padding of the header: not a button, so the drag is accepted.
    const from = { x: before.x + 3, y: before.y + 20 };
    await touchDrag(page, from, { x: from.x + 40, y: from.y + 60 });
    await expect.poll(async () => (await sidebar.boundingBox()).y).toBeGreaterThan(before.y + 30);
  });
});

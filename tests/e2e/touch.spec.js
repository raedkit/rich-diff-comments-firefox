/**
 * E2E: touch input (Firefox for Android / any hover:none device).
 *
 * Emulates a Pixel 7 so `@media (hover: none)` matches and pointers are
 * touch. Covers what the mouse suites can't:
 *   • the + is visible without any hover
 *   • one tap on the + opens the single-line comment box
 *   • dragging a + onto another + opens a range box
 *   • dragging the sidebar header moves the sidebar
 *
 * Chromium only: Playwright's Firefox has no isMobile / hover:none
 * emulation, and the touch drag below is injected through CDP.
 */
const { test, expect, devices } = require('@playwright/test');
const { setupExtensionPage } = require('./_helpers');
const fixtures = require('./fixtures/sources');

const fm = fixtures.yamlFrontmatter;

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

test.describe('touch input', () => {
  test.beforeEach(async ({ page }) => {
    await setupExtensionPage(page, 'yaml-frontmatter', {
      rawSource: { [fm.path]: fm.source },
    });
    // Fixtures have no viewport meta; without it mobile emulation lays out
    // at 980px and touch coordinates no longer match layout coordinates.
    await page.evaluate(() => {
      const meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1';
      document.head.appendChild(meta);
    });
  });

  test('the + is visible without hover and has a finger-sized target', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const btn = page.locator('h1', { hasText: 'Test Design Doc' }).locator('.grdc-comment-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveCSS('opacity', '0.6');
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
  });

  // Hosts whose + sits inside the viewport on a phone. Headings and
  // paragraphs hang the + in the left gutter (left: -30px), which is
  // off-screen on a narrow page; that placement is checked manually.
  const tapHost = (page) => page.locator('li', { hasText: 'Second overview bullet' });
  const dragStartHost = (page) => page.getByRole('rowheader', { name: 'feature', exact: true });

  test('one tap on the + opens a single-line comment box', async ({ page }) => {
    const host = tapHost(page);
    await host.scrollIntoViewIfNeeded();
    const point = await centerOf(host.locator('.grdc-comment-btn'));
    await page.touchscreen.tap(point.x, point.y);

    const box = page.locator('.grdc-comment-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.grdc-line-input')).toBeVisible();
    await expect(box.locator('.grdc-line-start-input')).toHaveCount(0);
  });

  test('dragging a + onto another + opens a range comment box', async ({ page }) => {
    const from = await centerOf(dragStartHost(page).locator('.grdc-comment-btn'));
    const to = await centerOf(tapHost(page).locator('.grdc-comment-btn'));

    await touchDrag(page, from, to);

    const box = page.locator('.grdc-comment-box');
    await expect(box).toBeVisible();
    await expect(page.locator('.grdc-comment-box')).toHaveCount(1);
    const start = Number(await box.locator('.grdc-line-start-input').inputValue());
    const end = Number(await box.locator('.grdc-line-input').inputValue());
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  test('dragging the sidebar header moves the sidebar', async ({ page }) => {
    const sidebar = page.locator('.grdc-sidebar');
    const header = sidebar.locator('.grdc-sidebar-header');
    await expect(header).toBeVisible();
    // The shared helper parks the sidebar at a desktop-sized x offset, which
    // is off-screen at phone width; bring it into view first.
    await sidebar.evaluate((el) => { el.style.left = '40px'; });
    const before = await sidebar.boundingBox();
    // Left padding of the header: not a button, so the drag is accepted.
    const from = { x: before.x + 3, y: before.y + 20 };
    await touchDrag(page, from, { x: from.x - 40, y: from.y + 60 });
    await expect.poll(async () => (await sidebar.boundingBox()).y).toBeGreaterThan(before.y + 30);
  });
});

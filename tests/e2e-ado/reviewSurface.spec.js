'use strict';

const { test, expect } = require('@playwright/test');
const {
  setupAdoExtensionPage,
  matchingRequests,
} = require('./_helpers');
const fixtures = require('./fixtures/sources');

async function clickCommentButton(host) {
  await host.hover();
  await host.locator('.adrc-comment-btn').dispatchEvent('click');
}

test.describe('ADO rendered review surface', () => {
  test('initializes through mocked ADO REST, maps lines, and builds all navigation panes', async ({ page }) => {
    const { pageErrors } = await setupAdoExtensionPage(page);
    const preview = page.locator('.markdown-preview-container');

    // Injected collapse/comment buttons become part of the heading's
    // accessible name, so select the host by DOM text rather than pinning an
    // exact post-injection ARIA name.
    const h1 = preview.locator('h1', { hasText: 'Design Review' });
    await expect(h1).toBeVisible();
    const button = h1.locator('.adrc-comment-btn');
    await expect(button).toHaveAttribute('title', new RegExp(`${fixtures.DESIGN_PATH}:1`));
    expect(await button.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    await h1.hover();
    await expect.poll(async () => Number(await button.evaluate((element) => getComputedStyle(element).opacity)))
      .toBeGreaterThan(0);

    const tableHeader = preview.locator('th', { hasText: 'Area' }).first();
    await tableHeader.hover();
    const tableButton = tableHeader.locator('.adrc-comment-btn');
    const [cellBox, buttonBox] = await Promise.all([tableHeader.boundingBox(), tableButton.boundingBox()]);
    expect(cellBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox.x).toBeGreaterThanOrEqual(cellBox.x - 2);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 2);

    await expect(page.locator('.adrc-thread-badge')).toHaveCount(2);
    await expect(page.locator('.adrc-sidebar-thread-card')).toHaveCount(3);
    await expect(page.locator('[data-count="threads"]')).toHaveText('3');
    await expect(page.getByText('The source branch was updated.')).toHaveCount(0);

    const state = await page.evaluate(() => window.ADORC_probe.sidebar());
    expect(state.currentFile).toBe(fixtures.DESIGN_PATH);
    expect(state.threadCount).toBe(3);
    expect(state.outlineCount).toBe(8);
    expect(state.changeCount).toBeGreaterThanOrEqual(2);
    expect(state.changesStatus).toBe('ready');
    await expect(page.locator('.adrc-sidebar-change-card')).toHaveCount(state.changeCount);

    expect(pageErrors).toEqual([]);
  });

  test('centers comment buttons on single-line paragraphs and list-item line boxes', async ({ page }) => {
    await setupAdoExtensionPage(page);
    const preview = page.locator('.markdown-preview-container');
    const paragraph = preview.locator('p', { hasText: 'durable queue' });
    const listItem = preview.locator('li', { hasText: 'Architecture' });

    for (const host of [paragraph, listItem]) {
      const button = host.locator(':scope > .adrc-comment-btn');
      const [hostBox, buttonBox, lineHeight] = await Promise.all([
        host.boundingBox(),
        button.boundingBox(),
        host.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight)),
      ]);
      expect(hostBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(Number.isFinite(lineHeight)).toBe(true);
      // These fixture blocks contain exactly one text line. Paragraphs center
      // against the host; list items center against their first line box so
      // this remains correct even when an item later gains a nested list.
      const expectedCenter = hostBox.y + Math.min(hostBox.height, lineHeight) / 2;
      const buttonCenter = buttonBox.y + buttonBox.height / 2;
      expect(Math.abs(buttonCenter - expectedCenter)).toBeLessThanOrEqual(1);
    }
  });

  test('marks exact table rows and cycles through multiple row threads', async ({ page }) => {
    const threads = fixtures.defaultThreads();
    const makeTableThread = (id, line, content, status = 'active', startLine = line) => ({
      id,
      status,
      threadContext: {
        filePath: fixtures.DESIGN_PATH,
        rightFileStart: { line: startLine, offset: 1 },
        rightFileEnd: { line, offset: 1 },
      },
      comments: [{
        id: 1,
        parentCommentId: 0,
        commentType: 1,
        content,
        author: fixtures.OTHER_USER,
        publishedDate: `2026-08-20T13:${id - 200}0:00.000Z`,
        lastContentUpdatedDate: `2026-08-20T13:${id - 200}0:00.000Z`,
        isDeleted: false,
      }],
    });
    threads.push(
      makeTableThread(201, 25, 'First API row thread.'),
      makeTableThread(202, 25, 'Second API row thread.', 'fixed'),
      makeTableThread(203, 26, 'UI row thread.'),
      makeTableThread(204, 25, 'Header-to-API range thread.', 'active', 23)
    );
    await setupAdoExtensionPage(page, { threads });

    const table = page.locator('.markdown-preview-container table');
    const headerRow = table.locator('thead tr');
    const apiRow = table.locator('tbody tr').filter({ hasText: 'API' });
    const uiRow = table.locator('tbody tr').filter({ hasText: 'UI' });
    await expect(headerRow.locator('.adrc-table-thread-marker')).toHaveCount(1);
    await expect(apiRow.locator('.adrc-table-thread-marker')).toHaveCount(1);
    await expect(uiRow.locator('.adrc-table-thread-marker')).toHaveCount(1);

    const apiMarker = apiRow.locator('.adrc-table-thread-marker');
    await expect(apiMarker).toHaveAttribute('aria-label', 'Open review threads on this table row; 3 threads');
    await expect(apiMarker).toHaveAttribute('data-count', '3');
    await expect(apiRow).toHaveText('APIPlatform');

    await apiMarker.click();
    await expect(page.locator('.adrc-thread-badge[data-thread-id="204"]')).toBeFocused();
    await apiMarker.press('Enter');
    await expect(page.locator('.adrc-thread-badge[data-thread-id="201"]')).toBeFocused();
    await apiMarker.press('Enter');
    await expect(page.locator('.adrc-thread-badge[data-thread-id="202"]')).toBeFocused();
    await expect(page.locator('.adrc-thread-panel[data-thread-id="202"]')).toBeVisible();
  });

  test('excludes non-Markdown threads and discards their stale pending jumps', async ({ page }) => {
    const threads = fixtures.defaultThreads();
    threads.push({
      id: 104,
      status: 'active',
      threadContext: {
        filePath: '/src/worker.js',
        rightFileStart: { line: 12, offset: 1 },
        rightFileEnd: { line: 12, offset: 1 },
      },
      comments: [{
        id: 1,
        parentCommentId: 0,
        commentType: 1,
        content: 'A source-code thread outside rendered Markdown review.',
        author: fixtures.OTHER_USER,
        publishedDate: '2026-08-20T13:00:00.000Z',
        lastContentUpdatedDate: '2026-08-20T13:00:00.000Z',
        isDeleted: false,
      }],
    });
    await setupAdoExtensionPage(page, { threads, waitForReady: false });

    await expect(page.locator('.adrc-sidebar-thread-card')).toHaveCount(3);
    await expect(page.locator('.adrc-sidebar-thread-card[data-path="/src/worker.js"]')).toHaveCount(0);
    await expect(page.locator('[data-count="threads"]')).toHaveText('3');

    await page.evaluate(() => {
      sessionStorage.setItem('adrc-pending-thread-jump-v1', JSON.stringify({
        id: 104,
        path: '/src/worker.js',
        identity: window.ADORC_probe.prIdentity,
        requirePreview: true,
        expiresAt: Date.now() + 90000,
      }));
      const url = new URL(location.href);
      url.searchParams.set('path', '/src/worker.js');
      history.pushState({}, '', url.href);
      window.__ADO_FIXTURE__.preview.style.display = 'none';
      window.__ADO_FIXTURE__.preview.innerHTML = '';
      document.querySelector('.fixture-view-mode').textContent = 'Inline';
    });

    await expect(page.locator('.adrc-sidebar-setup')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.adrc-sidebar-open-preview')).toHaveText('Open Markdown Preview');
    expect((await page.evaluate(() => window.ADORC_probe.viewMode())).pendingThreadJump).toBeNull();
  });

  test('posts a single-line comment with the exact ADO thread payload and refreshes the UI', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    expect(matchingRequests(server, 'GET', '/threads')).toHaveLength(1);
    const h1 = page.locator('.markdown-preview-container h1', { hasText: 'Design Review' });
    await clickCommentButton(h1);

    const editor = page.locator('.adrc-compose-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.adrc-editor-header')).toContainText(`${fixtures.DESIGN_PATH}:1`);
    await editor.locator('textarea').fill('**Looks good** from the ADO browser test.');
    await editor.locator('.adrc-editor-tab[data-tab="preview"]').click();
    await expect(editor.locator('.adrc-editor-preview strong')).toHaveText('Looks good');
    await editor.locator('.adrc-editor-submit').click();

    await expect.poll(() => matchingRequests(server, 'POST', '/threads').length).toBe(1);
    const request = matchingRequests(server, 'POST', '/threads')[0];
    expect(request.body.comments[0].content).toBe('**Looks good** from the ADO browser test.');
    expect(request.body.threadContext).toEqual({
      filePath: fixtures.DESIGN_PATH,
      rightFileStart: { line: 1, offset: 1 },
      rightFileEnd: { line: 1, offset: 1 },
    });

    await expect(page.locator('.adrc-thread-badge')).toHaveCount(3);
    await expect(page.locator('[data-count="threads"]')).toHaveText('4');
    expect(matchingRequests(server, 'GET', '/threads')).toHaveLength(2);
  });

  test('autocompletes an ADO identity and posts the native mention token', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const h1 = page.locator('.markdown-preview-container h1', { hasText: 'Design Review' });
    await clickCommentButton(h1);

    const editor = page.locator('.adrc-compose-editor');
    const textarea = editor.locator('textarea');
    await textarea.fill('@Example Mention');
    const option = page.locator('.adrc-mention-item', { hasText: fixtures.MENTION_USER.displayName });
    await expect(option).toBeVisible();
    await textarea.press('ArrowDown');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue(`@${fixtures.MENTION_USER.displayName} `);
    await textarea.fill(`@${fixtures.MENTION_USER.displayName} please review this.`);
    await editor.locator('.adrc-editor-submit').click();

    await expect.poll(() => matchingRequests(server, 'POST', '/threads').length).toBe(1);
    expect(matchingRequests(server, 'POST', '/threads')[0].body.comments[0].content)
      .toBe(`@<${fixtures.MENTION_USER.localId.toUpperCase()}> please review this.`);
    const mentionSearch = server.requests.find((request) =>
      request.method === 'POST' &&
      request.pathname.endsWith('/_apis/IdentityPicker/Identities') &&
      request.body.queryTypeHint !== 'uid'
    );
    expect(mentionSearch.body.query).toBe('Example Mention');
    expect(mentionSearch.body.identityTypes).toEqual(['user', 'group']);
    expect(mentionSearch.body.operationScopes).toEqual(['ims', 'source']);
    await expect(page.locator('.adrc-thread-comment-body .adrc-mention').last())
      .toHaveText(`@${fixtures.MENTION_USER.displayName}`);
  });

  test('posts from the third list item on its bullet line rather than the matching section heading', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const thirdBullet = page.locator('.markdown-preview-container li').nth(2);
    await expect(thirdBullet).toHaveText(/Architecture/);
    await clickCommentButton(thirdBullet);

    const editor = page.locator('.adrc-compose-editor');
    await expect(editor.locator('.adrc-editor-header')).toContainText(`${fixtures.DESIGN_PATH}:11`);
    await editor.locator('textarea').fill('Comment on the third bullet.');
    await editor.locator('.adrc-editor-submit').click();

    await expect.poll(() => matchingRequests(server, 'POST', '/threads').length).toBe(1);
    expect(matchingRequests(server, 'POST', '/threads')[0].body.threadContext).toEqual({
      filePath: fixtures.DESIGN_PATH,
      rightFileStart: { line: 11, offset: 1 },
      rightFileEnd: { line: 11, offset: 1 },
    });
  });

  test('tracks individual source lines inside an ADO-rendered code fence', async ({ page }) => {
    await setupAdoExtensionPage(page);
    const pre = page.locator('.markdown-preview-container pre');
    const button = pre.locator('.adrc-comment-btn');
    const box = await pre.boundingBox();
    expect(box).not.toBeNull();

    await pre.dispatchEvent('mousemove', { clientX: box.x + 8, clientY: box.y + 13 });
    await expect(button).toHaveAttribute('data-adrc-line', '17');
    await pre.dispatchEvent('mousemove', {
      clientX: box.x + 8,
      clientY: box.y + box.height - 13,
    });
    await expect(button).toHaveAttribute('data-adrc-line', '18');
    await expect(button).toHaveAttribute('title', `Comment on ${fixtures.DESIGN_PATH}:18`);

    await button.dispatchEvent('click');
    const editor = page.locator('.adrc-compose-editor');
    await expect(editor.locator('.adrc-line-input')).toHaveValue('18');
    await expect(editor.locator('.adrc-line-input')).toHaveAttribute('min', '17');
    await expect(editor.locator('.adrc-line-input')).toHaveAttribute('max', '18');
  });

  test('marks affected code lines and cycles through multiple line threads', async ({ page }) => {
    const makeCodeThread = (id, startLine, endLine, content, status = 'active') => ({
      id,
      status,
      threadContext: {
        filePath: fixtures.DESIGN_PATH,
        rightFileStart: { line: startLine, offset: 1 },
        rightFileEnd: { line: endLine, offset: 1 },
      },
      comments: [{
        id: 1,
        parentCommentId: 0,
        commentType: 1,
        content,
        author: fixtures.OTHER_USER,
        publishedDate: `2026-08-20T13:${id - 300}0:00.000Z`,
        lastContentUpdatedDate: `2026-08-20T13:${id - 300}0:00.000Z`,
        isDeleted: false,
      }],
    });
    const threads = [
      makeCodeThread(301, 17, 17, 'First retries-line thread.'),
      makeCodeThread(302, 17, 17, 'Second retries-line thread.', 'fixed'),
      makeCodeThread(303, 18, 18, 'Enqueue-line thread.'),
      makeCodeThread(304, 17, 18, 'Two-line range thread.'),
    ];
    await setupAdoExtensionPage(page, { threads });

    const pre = page.locator('.markdown-preview-container pre');
    const line17Marker = pre.locator('.adrc-code-line-thread-marker[data-line="17"]');
    const line18Marker = pre.locator('.adrc-code-line-thread-marker[data-line="18"]');
    await expect(line17Marker).toHaveCount(1);
    await expect(line18Marker).toHaveCount(1);
    await expect(line17Marker).toHaveAttribute('data-count', '3');
    await expect(line18Marker).toHaveAttribute('data-count', '2');
    await expect(line17Marker).toHaveAttribute('data-thread-ids', '301,302,304');
    await expect(line18Marker).toHaveAttribute('data-thread-ids', '304,303');
    await expect(pre).toContainText('const retries = 3;');

    const centers = await pre.evaluate((element) => {
      const rows = Array.from(element.querySelectorAll('code > span'));
      const markers = Array.from(element.querySelectorAll('.adrc-code-line-thread-marker'));
      return rows.map((row, index) => {
        const rowRect = row.getBoundingClientRect();
        const markerRect = markers[index].getBoundingClientRect();
        return Math.abs((rowRect.top + rowRect.height / 2) - (markerRect.top + markerRect.height / 2));
      });
    });
    expect(centers).toHaveLength(2);
    centers.forEach((difference) => expect(difference).toBeLessThanOrEqual(1));

    await line17Marker.click();
    await expect(page.locator('.adrc-thread-badge[data-thread-id="301"]')).toBeFocused();
    await line17Marker.press('Enter');
    await expect(page.locator('.adrc-thread-badge[data-thread-id="302"]')).toBeFocused();
    await expect(page.locator('.adrc-thread-panel[data-thread-id="302"]')).toBeVisible();
  });

  test('drags between rendered blocks and posts a normalized multi-line ADO range', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const startHost = page.locator('.markdown-preview-container p', { hasText: 'The worker uses a durable queue.' });
    const endHost = page.locator('.markdown-preview-container li', { hasText: 'Retry failed work' });
    const startButton = startHost.locator('.adrc-comment-btn');

    await endHost.scrollIntoViewIfNeeded();
    await startHost.hover();
    const startBox = await startButton.boundingBox();
    const endBox = await endHost.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();

    // Real mouse input: page.mouse.* emits pointerdown/move/up, which is what
    // the drag gesture listens to (touch takes the same path).
    const startPoint = {
      x: startBox.x + startBox.width / 2,
      y: startBox.y + startBox.height / 2,
    };
    const endPoint = {
      x: endBox.x + endBox.width / 2,
      y: endBox.y + endBox.height / 2,
    };
    await page.mouse.move(startPoint.x, startPoint.y);
    await page.mouse.down();
    await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 });
    await expect(page.locator('body')).toHaveClass(/adrc-dragging/);
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.adrc-hoverable')?.dataset.adrcLine,
    endPoint)).toBe('9');
    await page.mouse.up();

    const editor = page.locator('.adrc-compose-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.adrc-line-input-start')).toHaveValue('7');
    await expect(editor.locator('.adrc-line-input-end')).toHaveValue('9');
    await editor.locator('textarea').fill('Range comment from the ADO fixture.');
    await editor.locator('textarea').press('Control+Enter');

    await expect.poll(() => matchingRequests(server, 'POST', '/threads').length).toBe(1);
    const context = matchingRequests(server, 'POST', '/threads')[0].body.threadContext;
    expect(context.filePath).toBe(fixtures.DESIGN_PATH);
    expect(context.rightFileStart).toEqual({ line: 7, offset: 1 });
    expect(context.rightFileEnd).toEqual({ line: 9, offset: 1 });
    await expect(page.locator('.adrc-range-permanent')).not.toHaveCount(0);
  });

  test('posts a reply and re-renders the updated comment count', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const panel = page.locator('.adrc-thread-panel[data-thread-id="101"]');
    await expect(panel).toBeVisible();

    await panel.locator('.adrc-thread-reply').click();
    const textarea = panel.locator('.adrc-reply-editor textarea');
    await textarea.fill('Reply created through the fixture API.');
    await textarea.press('Control+Enter');

    await expect.poll(() => matchingRequests(server, 'POST', '/threads/101/comments').length).toBe(1);
    expect(matchingRequests(server, 'POST', '/threads/101/comments')[0].body.content)
      .toBe('Reply created through the fixture API.');
    await expect(page.locator('.adrc-thread-badge[data-thread-id="101"]')).toContainText('2 comments');
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-thread-comment')).toHaveCount(2);
  });

  test('resolves an active thread and collapses its inline panel', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const panel = page.locator('.adrc-thread-panel[data-thread-id="101"]');
    await panel.locator('.adrc-thread-toggle-status').click();

    await expect.poll(() => matchingRequests(server, 'PATCH', '/threads/101').length).toBe(1);
    expect(matchingRequests(server, 'PATCH', '/threads/101')[0].body).toEqual({ status: 2 });
    await expect(page.locator('.adrc-thread-badge[data-thread-id="101"]')).toHaveAttribute('data-status', 'fixed');
    await expect(page.locator('.adrc-thread-badge[data-thread-id="101"]')).toContainText('resolved');
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"]')).toHaveCount(0);
  });

  test('copies distinct native comment destinations with clear feedback', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => { window.__adrcCopiedText = text; },
        },
      });
    });
    const threads = fixtures.defaultThreads();
    threads[0].comments.push({
      id: 2,
      parentCommentId: 1,
      commentType: 1,
      content: 'A second comment shares the conversation destination.',
      author: fixtures.OTHER_USER,
      publishedDate: '2026-08-20T10:05:00.000Z',
      lastContentUpdatedDate: '2026-08-20T10:05:00.000Z',
      isDeleted: false,
    });
    await setupAdoExtensionPage(page, { threads });

    const copyLinks = page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-copy-comment-link');
    await expect(copyLinks).toHaveCount(2);
    await copyLinks.nth(1).click();

    await expect.poll(() => page.evaluate(() => window.__adrcCopiedText)).toBe(
      'https://dev.azure.com/test-org/test-project/_git/test-repo/pullRequest/42?discussionId=101#1787220300'
    );
    await expect(copyLinks.nth(1)).toHaveText('Copied!');
    await expect(copyLinks.nth(1)).toHaveAttribute('title', 'Comment link copied');

    await page.locator('.adrc-thread-badge[data-thread-id="102"]').click();
    await expect(page.locator('.adrc-thread-panel[data-thread-id="102"] .adrc-copy-comment-link'))
      .toBeVisible();
    await expect(page.locator('.adrc-thread-panel[data-thread-id="102"] .adrc-edit-comment'))
      .toHaveCount(0);
  });

  test('shows failure feedback when the thread link cannot be copied', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard denied'); } },
      });
    });
    await setupAdoExtensionPage(page);

    const copyLink = page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-copy-comment-link');
    await copyLink.click();
    await expect(copyLink).toHaveText('Copy failed');
    await expect(copyLink).toHaveAttribute('title', 'Could not copy comment link');
  });

  test('copies only the stored Markdown body for any visible comment', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => { window.__adrcCopiedText = text; },
        },
      });
    });
    const threads = fixtures.defaultThreads();
    threads[1].comments[0].content = 'Please keep **bold** and `code` exactly.\n\n- first\n- second';
    await setupAdoExtensionPage(page, { threads });

    await page.locator('.adrc-thread-badge[data-thread-id="102"]').click();
    const panel = page.locator('.adrc-thread-panel[data-thread-id="102"]');
    const copyMarkdown = panel.locator('.adrc-copy-comment-markdown');
    await expect(copyMarkdown).toBeVisible();
    await expect(panel.locator('.adrc-edit-comment')).toHaveCount(0);
    await copyMarkdown.click();

    await expect.poll(() => page.evaluate(() => window.__adrcCopiedText)).toBe(
      'Please keep **bold** and `code` exactly.\n\n- first\n- second'
    );
    await expect(copyMarkdown).toHaveText('Copied!');
    await expect(copyMarkdown).toHaveAttribute('title', 'Comment Markdown copied');
  });

  test('edits an own comment and displays the server-updated Markdown', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const panel = page.locator('.adrc-thread-panel[data-thread-id="101"]');
    const edit = panel.locator('.adrc-edit-comment');
    await expect(edit).toBeVisible();
    await edit.click();

    const editor = panel.locator('.adrc-inline-edit-editor');
    await editor.locator('textarea').fill('Edited with **browser coverage**.');
    await editor.locator('.adrc-editor-submit').click();

    await expect.poll(() => matchingRequests(server, 'PATCH', '/threads/101/comments/1').length).toBe(1);
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-thread-comment-body strong'))
      .toHaveText('browser coverage');
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-thread-comment-edited'))
      .toContainText('edited');
  });

  test('hydrates and preserves an existing native mention while editing', async ({ page }) => {
    const threads = fixtures.defaultThreads();
    const token = `@<${fixtures.MENTION_USER.localId.toUpperCase()}>`;
    threads[0].comments[0].content = `${token} please review this.`;
    const { server } = await setupAdoExtensionPage(page, { threads });

    const panel = page.locator('.adrc-thread-panel[data-thread-id="101"]');
    await expect(panel.locator('.adrc-thread-comment-body .adrc-mention'))
      .toHaveText(`@${fixtures.MENTION_USER.displayName}`);
    await page.keyboard.press('2');
    await expect(page.locator('.adrc-sidebar-thread-card[data-thread-id="101"] .adrc-sidebar-thread-snippet'))
      .toContainText(`@${fixtures.MENTION_USER.displayName}`);
    await expect(page.locator('.adrc-sidebar-thread-card[data-thread-id="101"] .adrc-sidebar-thread-snippet'))
      .not.toContainText(fixtures.MENTION_USER.localId);
    const uidLookup = server.requests.find((request) =>
      request.method === 'POST' &&
      request.pathname.endsWith('/_apis/IdentityPicker/Identities') &&
      request.body.queryTypeHint === 'uid'
    );
    expect(uidLookup.body.query).toBe(fixtures.MENTION_USER.localId.toUpperCase());

    await panel.locator('.adrc-edit-comment').click();
    const editor = panel.locator('.adrc-inline-edit-editor');
    const textarea = editor.locator('textarea');
    await expect(textarea)
      .toHaveValue(`@${fixtures.MENTION_USER.displayName} please review this.`);
    await textarea.press('Home');
    await textarea.type('Note: ');
    await textarea.press('End');
    await textarea.press('ArrowLeft');
    await textarea.type(' update');
    await editor.locator('.adrc-editor-submit').click();

    await expect.poll(() => matchingRequests(server, 'PATCH', '/threads/101/comments/1').length).toBe(1);
    expect(matchingRequests(server, 'PATCH', '/threads/101/comments/1')[0].body.content)
      .toBe(`Note: ${token} please review this update.`);
    await expect(panel.locator('.adrc-thread-comment-body .adrc-mention'))
      .toHaveText(`@${fixtures.MENTION_USER.displayName}`);
  });

  test('keeps a thread with a deleted root when an undeleted reply remains', async ({ page }) => {
    const threads = fixtures.defaultThreads();
    delete threads[0].comments[0].content;
    threads[0].comments[0].isDeleted = true;
    threads[0].comments.push({
      id: 2,
      parentCommentId: 1,
      commentType: 1,
      content: 'The remaining reply stays actionable.',
      author: fixtures.OTHER_USER,
      publishedDate: '2026-08-20T10:05:00.000Z',
      lastContentUpdatedDate: '2026-08-20T10:05:00.000Z',
      isDeleted: false,
    });
    await setupAdoExtensionPage(page, { threads });

    await expect(page.locator('.adrc-thread-badge[data-thread-id="101"]')).toContainText('1 comment');
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-thread-comment-deleted'))
      .toHaveText('(This comment was deleted.)');
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"] .adrc-thread-comment-body'))
      .toContainText(['(This comment was deleted.)', 'The remaining reply stays actionable.']);
    await expect(page.locator('.adrc-sidebar-thread-card[data-thread-id="101"] .adrc-sidebar-thread-snippet'))
      .toHaveText('The remaining reply stays actionable.');
  });

  test('requires inline confirmation before hiding an all-deleted thread', async ({ page }) => {
    const { server } = await setupAdoExtensionPage(page);
    const panel = page.locator('.adrc-thread-panel[data-thread-id="101"]');
    const deleteButton = panel.locator('.adrc-delete-comment');
    await deleteButton.click();
    await expect(deleteButton).toHaveText('Confirm delete');
    expect(matchingRequests(server, 'DELETE', '/threads/101/comments/1')).toHaveLength(0);

    await deleteButton.click();
    await expect.poll(() => matchingRequests(server, 'DELETE', '/threads/101/comments/1').length).toBe(1);
    await expect(page.locator('.adrc-thread-panel[data-thread-id="101"]')).toHaveCount(0);
    await expect(page.locator('.adrc-thread-badge[data-thread-id="101"]')).toHaveCount(0);
    await expect(page.locator('.adrc-sidebar-thread-card[data-thread-id="101"]')).toHaveCount(0);
    await expect(page.locator('[data-count="threads"]')).toHaveText('2');
  });
});

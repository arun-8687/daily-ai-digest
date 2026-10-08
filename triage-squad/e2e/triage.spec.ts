// The end-to-end race from SPEC section 6. Two responders look at the same incident in two browsers.
//
//   A = bob (responder) acks the incident.
//   B = alice (admin) opened the Resolve dialog before the ack, so it pins version 1.
//
// B's row must show "Acked" in under one second after A's ack response. B then confirms its stale resolve. The server
// rejects it with 409 version_conflict, the toast says the change was rolled back, and the row stays "Acked" (version 2).
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEMO_PASSWORD, E2E_BASE_URL, INGEST_TOKEN } from './paths';

/** The live update must reach B's row within this many milliseconds of A's ack response. */
const LIVE_UPDATE_BUDGET_MS = 1000;

interface Responder {
  context: BrowserContext;
  page: Page;
}

async function signIn(browser: Browser, deepLink: string, username: string): Promise<Responder> {
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  const page = await context.newPage();
  await page.goto(deepLink);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return { context, page };
}

test('a stale resolve is rejected and the live ack reaches the other responder within one second', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  // 1. Create an incident through the real ingest endpoint.
  const title = `E2E race ${randomUUID().slice(0, 8)}`;
  const ingest = await request.post('/ingest', {
    headers: { Authorization: `Bearer ${INGEST_TOKEN}` },
    data: {
      source: 'e2e',
      fingerprint: `e2e/${randomUUID()}`,
      severity: 'warning',
      title,
      ts: Date.now(),
      payload: { suite: 'triage-race' },
    },
  });
  expect(ingest.status()).toBe(202);
  const { incidentId: id } = (await ingest.json()) as { incidentId: number };

  // 2. Both responders deep-link to the incident.
  const deepLink = `/?${new URLSearchParams({ q: title, sel: String(id) }).toString()}`;
  const bob = await signIn(browser, deepLink, 'bob');
  const alice = await signIn(browser, deepLink, 'alice');

  try {
    const row = (page: Page) => page.locator(`#inc-${id}`);
    const drawer = (page: Page) => page.getByRole('region', { name: `INC-${id}: ${title}` });

    await expect(alice.page.locator('.conn')).toHaveText('Live', { timeout: 15_000 });
    await expect(drawer(alice.page)).toBeVisible();
    await expect(row(alice.page)).toContainText('Open');
    await expect(drawer(bob.page)).toBeVisible();
    // Bob's stream must be up too, so his ack is the one whose live fan-out is being measured.
    await expect(bob.page.locator('.conn')).toHaveText('Live', { timeout: 15_000 });

    // 3. Alice opens Resolve. The dialog pins version 1.
    await drawer(alice.page).getByRole('button', { name: /^Resolve/ }).click();
    const resolveDialog = alice.page.getByRole('dialog', { name: `Resolve INC-${id}?` });
    await expect(resolveDialog).toBeVisible();

    // 4. Bob acks. The clock starts only after his ack response has arrived.
    const ackResponse = bob.page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/incidents/${id}/ack`,
    );
    await drawer(bob.page).getByRole('button', { name: 'Ack', exact: true }).click();
    const ack = await ackResponse;
    expect(ack.status()).toBe(200);

    const started = performance.now();
    await alice.page.waitForFunction(`document.getElementById('inc-${id}')?.textContent?.includes('Acked') === true`, undefined, {
      polling: 'raf',
      timeout: 5_000,
    });
    const elapsed = performance.now() - started;
    console.log(`live ack reached Alice ${elapsed.toFixed(0)} ms after Bob's ack response (budget ${LIVE_UPDATE_BUDGET_MS} ms)`);
    expect(elapsed,`live ack reached Alice ${elapsed.toFixed(0)} ms after Bob's ack response`).toBeLessThan(
      LIVE_UPDATE_BUDGET_MS,
    );

    // 5. Alice confirms her stale resolve. It carries version 1, so the server must refuse it.
    const staleResolve = alice.page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/incidents/${id}/resolve`,
    );
    await resolveDialog.getByRole('button', { name: 'Resolve incident' }).click();
    const rejected = await staleResolve;
    expect(rejected.status()).toBe(409);
    const conflict = (await rejected.json()) as { error: { code: string }; current: { status: string; version: number } };
    expect(conflict.error.code).toBe('version_conflict');
    expect(conflict.current).toMatchObject({ status: 'acked', version: 2 });

    const toast = alice.page.getByRole('alert').filter({ hasText: 'changed while you were looking at it' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('rolled back');

    await expect(row(alice.page)).toContainText('Acked');
    await expect(row(alice.page)).not.toContainText('Resolved');

    // The server agrees: still acked, at version 2.
    const detail = await alice.page.request.get(`/api/incidents/${id}`);
    expect(detail.status()).toBe(200);
    const { incident } = (await detail.json()) as { incident: { status: string; version: number } };
    expect(incident.status).toBe('acked');
    expect(incident.version).toBe(2);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

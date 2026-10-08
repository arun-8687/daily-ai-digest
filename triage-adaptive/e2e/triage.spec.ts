// SPEC section 6, e2e: a stale resolve is rejected and rolled back, and the other responder sees the ack live.
//   1. Ingest a uniquely titled warning incident through /ingest.
//   2. Both responders deep-link to /?q=<title>&sel=<id>. Wait for B's connection badge to show Live.
//   3. B opens Resolve… (the dialog pins version 1).
//   4. A acks. The timer starts after A's /ack response. B's row must show Acked within 1000ms.
//   5. B confirms the resolve. The server rejects it (version 2 now), B sees the rollback message,
//      B's row shows Acked, and the server holds the incident as acked at version 2.
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

const INGEST_TOKEN = 'dev-ingest-token';
const PASSWORD = 'triage-demo';

async function signedInContext(browser: Browser, username: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  const res = await context.request.post('/api/auth/login', { data: { username, password: PASSWORD } });
  expect(res.status(), `login as ${username}`).toBe(200);
  return context;
}

test('a stale resolve is rolled back when another responder has acked the incident', async ({ browser, request }) => {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `e2e race ${stamp}`;

  // Context A is bob (responder). Context B is alice (admin, which can also resolve).
  const contextA = await signedInContext(browser, 'bob');
  const contextB = await signedInContext(browser, 'alice');
  try {
    // 1. Ingest a uniquely titled warning incident.
    const ingest = await request.post('/ingest', {
      headers: { Authorization: `Bearer ${INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      data: {
        source: 'e2e',
        fingerprint: `e2e/${stamp}`,
        severity: 'warning',
        title,
        payload: { suite: 'triage-e2e' },
        ts: Date.now(),
      },
    });
    expect(ingest.status()).toBe(202);
    const { incidentId: id, action } = (await ingest.json()) as { incidentId: number; action: string };
    expect(action).toBe('created');

    // 2. Both deep-link to the incident. B must be live before the race starts.
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const deepLink = `/?q=${encodeURIComponent(title)}&sel=${id}`;
    await Promise.all([pageA.goto(deepLink), pageB.goto(deepLink)]);
    await expect(pageB.locator('.conn')).toHaveText('Live');

    const drawerA = pageA.getByRole('region', { name: `INC-${id}: ${title}`, exact: true });
    const drawerB = pageB.getByRole('region', { name: `INC-${id}: ${title}`, exact: true });
    const rowB = pageB.locator(`#inc-${id}`);
    await expect(rowB).toContainText('Open');

    // 3. B opens Resolve… and the dialog pins version 1.
    await drawerB.getByRole('button', { name: /^Resolve/ }).click();
    const dialogB = pageB.getByRole('dialog', { name: `Resolve INC-${id}?`, exact: true });
    await expect(dialogB).toBeVisible();

    // 4. A acks. The clock starts once A's /ack response has arrived.
    const ackResponse = pageA.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/incidents/${id}/ack`,
    );
    await drawerA.getByRole('button', { name: 'Ack', exact: true }).click();
    const ack = await ackResponse;
    expect(ack.status()).toBe(200);
    const ackReceivedAt = Date.now();

    // A string expression: the root tsconfig has no DOM lib, and the id is a server-issued integer.
    await pageB.waitForFunction(`document.getElementById('inc-${id}')?.textContent?.includes('Acked') === true`, undefined, {
      timeout: 5_000,
    });
    const elapsed = Date.now() - ackReceivedAt;
    console.log(`[e2e] B's row showed Acked ${elapsed}ms after A's /ack response`);
    expect(elapsed, `B's row showed Acked ${elapsed}ms after A's ack response`).toBeLessThan(1000);
    await expect(rowB).toContainText('Acked');
    // The open dialog should now warn that the incident moved.
    await expect(dialogB.getByRole('status')).toContainText('changed after you opened this dialog');

    // 5. B confirms the resolve. The server refuses it (pinned version 1, now version 2).
    await dialogB.getByRole('button', { name: 'Resolve incident' }).click();
    const failure = pageB.getByRole('alert').filter({ hasText: 'changed while you were looking at it' });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('rolled back');

    // B's row settles on the server's state: Acked, not Resolved.
    await expect(rowB).toContainText('Acked');
    await expect(rowB).not.toContainText('Resolved');

    const detail = await contextA.request.get(`/api/incidents/${id}`);
    expect(detail.status()).toBe(200);
    const { incident } = (await detail.json()) as { incident: { status: string; version: number } };
    expect(incident.status).toBe('acked');
    expect(incident.version).toBe(2);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

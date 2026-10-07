import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from './paths';

// Two independent sessions (separate browser contexts, so separate cookies):
//   A = bob (responder) acks an incident.
//   B = alice (admin) has the resolve confirmation open for the same incident.
// B sees the ack live. B then confirms its resolve, which still pins the version it
// reviewed. The server rejects it, and B's optimistic change is rolled back.

async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('triage-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('listbox', { name: 'Incidents' })).toBeVisible();
}

test('A acks, B sees it within 1s, and B\'s stale resolve is rejected and rolled back', async ({ browser, request }) => {
  const title = `e2e payments timeout ${Date.now()}`;
  const ingest = await request.post(`${BASE_URL}/ingest`, {
    headers: { authorization: 'Bearer dev-ingest-token' },
    data: {
      source: 'e2e',
      fingerprint: `e2e-${Date.now()}`,
      severity: 'warning',
      title,
      payload: { suite: 'two-sessions' },
      ts: new Date().toISOString(),
    },
  });
  expect(ingest.status()).toBe(202);
  const { incidentId } = (await ingest.json()) as { incidentId: number };
  const row = (page: Page) => page.locator(`#inc-${incidentId}`);
  const query = new URLSearchParams({ q: title, sel: String(incidentId) }).toString();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  await signIn(a, 'bob');
  await signIn(b, 'alice');

  // Both sessions deep-link to the incident (filters and the drawer both live in the URL).
  await a.goto(`/?${query}`);
  await b.goto(`/?${query}`);
  for (const page of [a, b]) {
    await expect(row(page)).toContainText('Open');
    await expect(page.getByRole('region', { name: `INC-${incidentId}` }).getByRole('heading', { level: 2 })).toHaveText(title);
  }
  await expect(b.locator('.conn')).toContainText('Live');

  // B opens the resolve confirmation. It pins version 1, the one B has reviewed.
  await b.getByRole('button', { name: /^Resolve/ }).click();
  await expect(b.getByRole('dialog', { name: `Resolve INC-${incidentId}?` })).toBeVisible();

  // A acks, and B's list must show it within one second.
  const ackStarted = Date.now();
  await a.getByRole('button', { name: /^Ack/ }).click();
  await expect(row(a)).toContainText('Acked');
  await expect(row(b)).toContainText('Acked', { timeout: 1000 });
  expect(Date.now() - ackStarted).toBeLessThan(2000);

  // B confirms the resolve with its stale pinned version. The server must reject it.
  await b.getByRole('dialog').getByRole('button', { name: 'Resolve incident' }).click();
  const conflict = b.getByRole('alert').filter({ hasText: 'changed while you were looking at it' });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('Your change was rolled back');

  // Rolled back: B shows Acked again and never settles on Resolved.
  await expect(row(b)).toContainText('Acked');
  await expect(row(b)).not.toContainText('Resolved');

  // The server agrees: still acked, and the stale resolve never applied.
  const detail = await contextB.request.get(`${BASE_URL}/api/incidents/${incidentId}`);
  const body = (await detail.json()) as { incident: { status: string; version: number; ackedBy: string } };
  expect(body.incident).toMatchObject({ status: 'acked', version: 2, ackedBy: 'u_bob' });

  await expect(row(a)).toContainText('Acked');
  await contextA.close();
  await contextB.close();
});

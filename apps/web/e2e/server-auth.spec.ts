import { expect, test } from '@playwright/test';

const API = 'http://localhost:3002';

test.describe('the proxy rejects requests without the household code', () => {
  test('sync and AI endpoints return 401; the right code is accepted; unknown profiles are refused', async ({
    request,
  }) => {
    for (const [method, route] of [
      ['GET', '/v1/sync/ron'],
      ['PUT', '/v1/sync/ron'],
      ['POST', '/v1/turn'],
      ['POST', '/v1/journal-review'],
      ['POST', '/v1/define'],
    ] as const) {
      const res = await request.fetch(`${API}${route}`, { method, data: {} });
      expect(res.status(), route).toBe(401);
      const wrong = await request.fetch(`${API}${route}`, {
        method,
        data: {},
        headers: { 'x-site-code': 'nope' },
      });
      expect(wrong.status(), `${route} wrong code`).toBe(401);
    }
    expect(
      (await request.get(`${API}/v1/auth/check`, { headers: { 'x-site-code': 'tofu' } })).status(),
    ).toBe(200);
    expect(
      (
        await request.get(`${API}/v1/sync/mallory`, { headers: { 'x-site-code': 'tofu' } })
      ).status(),
    ).toBe(404);
    expect((await request.get(`${API}/v1/health`)).status()).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('worker smoke', () => {
  it('GET /health responds ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

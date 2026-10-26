import { expect, it, vi } from 'vitest';
import { fetchInvoiceFeed } from '../src/toolsets/invoice/source.js';
it('fetches the official RSS with user agent and timeout signal', async () => {
  const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response('<rss/>'));
  expect(await fetchInvoiceFeed(fake)).toBe('<rss/>');
  expect(fake).toHaveBeenCalledWith('https://invoice.etax.nat.gov.tw/invoice.xml', { headers: { 'User-Agent': 'formosa-mcp' }, signal: expect.any(AbortSignal) });
});
it('rejects non-200 responses clearly', async () => {
  const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
  await expect(fetchInvoiceFeed(fake)).rejects.toThrow('HTTP 503');
});

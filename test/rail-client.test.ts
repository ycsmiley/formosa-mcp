import { afterEach, expect, it, vi } from 'vitest';
import { readJsonLimited, unavailable } from '../src/core/rail/client.js';
import { workerRail, type RailEnv } from '../src/worker/rail.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('reads JSON at the exact byte limit, preserving split UTF-8 characters', async () => {
  const data = { station: '臺北' }, bytes = new TextEncoder().encode(JSON.stringify(data));
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
  await expect(readJsonLimited(response, bytes.length)).resolves.toEqual(data);
});
it('rejects an excessive content-length before reading the body', async () => {
  const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '11' } });
  const reader = vi.spyOn(response.body!, 'getReader');
  await expect(readJsonLimited(response, 10)).rejects.toThrow(unavailable);
  expect(reader).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});
it.each([undefined, '1'])('counts streamed bytes and cancels at overflow with content-length %s', async length => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(5));
  }, cancel }), { headers: length ? { 'content-length': length } : {} });
  await expect(readJsonLimited(response, 10)).rejects.toThrow(unavailable);
  expect(cancel).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false);
});
it('rejects invalid JSON within the limit', async () => {
  await expect(readJsonLimited(new Response('invalid'), 10)).rejects.toThrow(SyntaxError);
});
it.each(['token', 'live', 'stations', 'od'])('returns unavailable for an oversized user-key %s response', async endpoint => {
  const http = vi.fn(async (url: string, _init?: RequestInit) => {
    const target = url.endsWith('/token') ? 'token' : url.includes('/Station?') ? 'stations' : url.includes('/OD/') ? 'od' : 'live';
    if (target === endpoint) return new Response('{}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
    return Response.json(target === 'token' ? { access_token: 'private-token' } : [
      { StationID: '1000', StationName: { Zh_tw: '臺北' } }, { StationID: '1070', StationName: { Zh_tw: '左營' } },
    ]);
  });
  vi.stubGlobal('fetch', http);
  const service = workerRail({} as RailEnv, 'ip', { clientId: 'private-id', clientSecret: 'private-secret' });
  const result = ['stations', 'od'].includes(endpoint)
    ? await service.timetable('THSR', { origin: '臺北', destination: '左營', date: '2026-10-30' })
    : await service.live({ train_no: '123' });
  expect(result.isError).toBe(true); expect(result.text).toContain(unavailable);
  expect(result.text).not.toContain('private');
  expect(http.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
});

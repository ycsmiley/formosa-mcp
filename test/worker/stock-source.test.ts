import { afterEach, expect, it, vi } from 'vitest';
import { fetchStockFeed } from '../../src/worker/stock-source.js';
import { stockUrls } from '../../src/core/stock/source.js';

const feed = 'tpex-quotes', url = `${stockUrls[feed]}?token=private-query`;
const load = () => fetchStockFeed(feed, url, undefined, { retryDelayMs: 0 });
const warning = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('logs one bounded HTTP diagnostic with market, feed, host/path and no query', async () => {
  const body = `Access\n  denied ${'x'.repeat(300)}END`;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 403 }));
  const warn = warning();
  await expect(load()).rejects.toThrow('HTTP 403');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^stock feed fail tpex tpex-quotes www\.tpex\.org\.tw\/openapi\/v1\/tpex_mainboard_quotes status=403 body=".*" ms=\d+$/));
  const line = warn.mock.calls[0][0] as string;
  expect(line).toContain(`body=${JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 200))}`);
  expect(line).not.toMatch(/private-query|token=|\?|END|\n/);
});

it('keeps the HTTP error when reading the diagnostic body fails', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('body read failed')); } }), { status: 403 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const warn = warning();
  await expect(load()).rejects.toThrow('HTTP 403');
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('status=403 body=""'));
});

it.each([
  { contentType: 'text/html', body: `<html>\n  Access denied ${'x'.repeat(300)}END</html>`, error: 'Unexpected content-type: text/html' },
  { contentType: 'application/json', body: '{"broken":\n invalid}', error: 'SyntaxError' },
  { contentType: null, body: '{"broken":\n invalid}', error: 'SyntaxError' },
])('logs one bounded diagnostic and does not retry a 200 failure with content-type=$contentType', async ({ contentType, body, error }) => {
  const response = new Response(body, { headers: contentType ? { 'Content-Type': contentType } : {} });
  if (contentType === null) response.headers.delete('Content-Type');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const warn = warning();
  await expect(load()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^stock feed fail tpex tpex-quotes www\.tpex\.org\.tw\/openapi\/v1\/tpex_mainboard_quotes status=200 body=".*" error=.* ms=\d+$/));
  const line = warn.mock.calls[0][0] as string;
  expect(line).toContain(`body=${JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 200))}`);
  expect(line).toContain(error);
  expect(line).not.toMatch(/private-query|token=|\?|END|\n/);
});

it('parses a 200 response with no content-type header successfully', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new TextEncoder().encode('[{"ok":true}]')));
  const warn = warning();
  await expect(load()).resolves.toEqual({ status: 200, body: [{ ok: true }], validators: {} });
  expect(warn).not.toHaveBeenCalled();
});

it.each([403, 200])('promptly logs a 200-character prefix and cancels an endless non-JSON body with status=%i', async status => {
  const text = `Access\n  denied ${'界'.repeat(1000)}`, bytes = new TextEncoder().encode(text);
  let offset = 0;
  const cancel = vi.fn(), body = new ReadableStream({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 0));
      controller.enqueue(bytes.slice(offset, offset + 127));
      offset = (offset + 127) % bytes.length;
    },
    cancel,
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': 'text/html' } }));
  const warn = warning();
  await expect(load()).rejects.toThrow(status === 403 ? 'HTTP 403' : 'Unexpected content-type: text/html');
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`status=${status} body=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 200))}`));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(offset).toBeLessThanOrEqual(127 * 10);
}, 1000);

it('logs a thrown fetch only after the final attempt, with the error name and message', async () => {
  const error = new TypeError(`network down\n ${url}`);
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
  const warn = warning();
  await expect(load()).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`error=TypeError: network down ${stockUrls[feed]} ms=`));
  expect(warn.mock.calls[0][0]).not.toMatch(/private-query|token=|\?|\n/);
});

it.each([503, 429])('retries %i once, cancels the first body and succeeds without a failure log', async status => {
  const response = new Response('try again', { status });
  const cancel = vi.spyOn(response.body!, 'cancel');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response).mockImplementationOnce(async () => {
    expect(cancel).toHaveBeenCalledTimes(1);
    return Response.json([{ ok: true }]);
  });
  const warn = warning();
  await expect(load()).resolves.toEqual({ status: 200, body: [{ ok: true }], validators: {} });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]?.signal).toBe(fetch.mock.calls[1][1]?.signal);
  expect(warn).not.toHaveBeenCalled();
});

it.each([new TypeError('network down'), new DOMException('attempt aborted', 'AbortError')])('retries a thrown $name and succeeds', async error => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(error).mockResolvedValueOnce(Response.json([]));
  const warn = warning();
  await expect(load()).resolves.toEqual({ status: 200, body: [], validators: {} });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(warn).not.toHaveBeenCalled();
});

it.each([404, 429, 503])('makes at most the allowed attempts for persistent %i and logs once', async status => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status }));
  const warn = warning();
  await expect(load()).rejects.toThrow(`HTTP ${status}`);
  expect(fetch).toHaveBeenCalledTimes(status === 404 ? 1 : 2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`status=${status}`));
});

it('does not retry after the overall signal aborts', async () => {
  const controller = new AbortController(), error = new DOMException('deadline', 'TimeoutError');
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(error); throw error; });
  const warn = warning();
  await expect(load()).rejects.toBe(error);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(45_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('error=TimeoutError: deadline'));
});

it('waits 1.5 seconds by default and includes that time in the final diagnostic', async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
  const warn = warning();
  const result = expect(fetchStockFeed(feed, url)).rejects.toThrow('network down');
  await vi.advanceTimersByTimeAsync(1499);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ms=1500'));
});

it.each(['twse-quotes', 'tpex-quotes'] as const)('sends explicit and conditional headers for %s; 304 succeeds silently', async feed => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 304 }));
  const warn = warning();
  await expect(fetchStockFeed(feed, stockUrls[feed], { etag: '"version"', lastModified: 'Tue, 27 Oct 2026 01:00:00 GMT' })).resolves.toEqual({ status: 304 });
  expect(Object.fromEntries(new Headers(fetch.mock.calls[0][1]?.headers))).toEqual({
    'user-agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)', accept: 'application/json',
    'if-none-match': '"version"', 'if-modified-since': 'Tue, 27 Oct 2026 01:00:00 GMT',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

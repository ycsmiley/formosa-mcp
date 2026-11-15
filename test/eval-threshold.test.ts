import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, decide, githubApi, offlineApi, readResult, taipeiDate, type Api, type Result, type State } from '../scripts/eval-threshold.js';
const now = new Date('2026-11-04T16:01:00Z'), marker = '<!-- eval-regression:2026-11-05 -->';
const result = (passed = 8): Result => ({ total: 10, passed, accuracy: passed / 10, failures: Array.from({ length: 10 - passed }, (_, i) => `q${i}`), date: '2026-11-04' });
const state = (patch: Partial<State> = {}): State => ({ issues: [], comments: {}, labelExists: false, ...patch });
function harness(s = state()) {
  const offline = offlineApi(s), api = vi.fn<Api>(async (method, path, body) => method === 'GET' ? offline(method, path, body) : {}), log = vi.fn();
  return { api, log, options: { now, log } };
}
it.each([9, 10])('passes at or above 90%% without GitHub (%i/10)', async passed => {
  const h = harness(); expect(await decide(result(passed), h.api, h.options)).toEqual({ exitCode: 0, action: 'pass' }); expect(h.api).not.toHaveBeenCalled();
});
it('creates the label and one issue below threshold', async () => {
  const h = harness(); expect(await decide(result(), h.api, h.options)).toEqual({ exitCode: 1, action: 'create' });
  expect(h.api.mock.calls.filter(([m]) => m === 'POST')).toEqual([
    ['POST', '/labels', expect.objectContaining({ name: 'eval-regression' })],
    ['POST', '/issues', expect.objectContaining({ labels: ['eval-regression'], body: expect.stringContaining(marker) })],
  ]);
});
it('reuses an existing label', async () => {
  const h = harness(state({ labelExists: true })); await decide(result(), h.api, h.options);
  expect(h.api.mock.calls.filter(([m]) => m === 'POST').map(([, p]) => p)).toEqual(['/issues']);
});
it('comments on the oldest open labelled issue, excluding PRs', async () => {
  const h = harness(state({ issues: [{ number: 1, body: '', pull_request: {} }, { number: 9, body: '' }, { number: 6, body: '' }] }));
  expect((await decide(result(), h.api, h.options)).action).toBe('comment');
  expect(h.api).toHaveBeenCalledWith('POST', '/issues/6/comments', { body: expect.stringContaining(marker) });
});
it.each(['body', 'comments'])('deduplicates using the Taipei calendar day in %s', async where => {
  const h = harness(state({ issues: [{ number: 6, body: where === 'body' ? marker : '' }], comments: { 6: where === 'comments' ? [{ body: marker }] : [] } }));
  expect(await decide(result(), h.api, h.options)).toEqual({ exitCode: 1, action: 'skip-duplicate' });
  expect(h.api.mock.calls.some(([m]) => m === 'POST')).toBe(false);
});
it('finds duplicate markers beyond the first page of comments', async () => {
  const h = harness(state({ issues: [{ number: 6, body: null }], comments: { 6: [...Array.from({ length: 100 }, () => ({ body: 'old' })), { body: marker }] } }));
  expect((await decide(result(), h.api, h.options)).action).toBe('skip-duplicate');
  expect(h.api).toHaveBeenCalledWith('GET', '/issues/6/comments?per_page=100&page=2');
});
it('paginates open issues and permits a comment on the next Taipei day', async () => {
  const h = harness(state({ issues: [...Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: '', pull_request: {} })), { number: 101, body: '<!-- eval-regression:2026-11-04 -->' }] }));
  expect((await decide(result(), h.api, h.options)).action).toBe('comment');
  expect(h.api).toHaveBeenCalledWith('GET', '/issues?state=open&labels=eval-regression&per_page=100&page=2');
});
it.each(['create', 'comment', 'skip-duplicate'])('dry-run prints the exact %s action with no writes or network', async action => {
  const h = harness(state({ issues: action === 'create' ? [] : [{ number: 6, body: action === 'skip-duplicate' ? marker : '' }] }));
  expect((await decide(result(), h.api, { ...h.options, dryRun: true })).action).toBe(action);
  expect(h.api.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  expect(h.log.mock.calls.at(-1)?.[0]).toMatch(new RegExp(`^${action}:`));
  if (action !== 'skip-duplicate') expect(h.log.mock.calls.at(-1)?.[0]).toContain(JSON.stringify(marker).slice(1, -1));
});
it('does not create an issue after a failed search or label permission error', async () => {
  for (const failAt of ['search', 'label']) {
    const api = vi.fn<Api>(async (_m, path) => { if (failAt === 'label' && path.startsWith('/issues?')) return []; throw new ApiError(403); });
    await expect(decide(result(), api, { now, log: () => {} })).rejects.toThrow('HTTP 403');
    expect(api.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  }
});
it('uses Taipei midnight, independent of the runner timezone', () => {
  expect(taipeiDate(new Date('2026-11-04T15:59:59Z'))).toBe('2026-11-04'); expect(taipeiDate(now)).toBe('2026-11-05');
});
const temp = mkdtempSync(join(tmpdir(), 'eval-threshold-'));
afterEach(() => { rmSync(join(temp, 'result.json'), { force: true }); });
it.each(['missing', 'malformed', 'inconsistent', 'empty', 'valid'])('reads %s results; crash/no file becomes accuracy zero and files an issue', async kind => {
  const path = join(temp, 'result.json');
  if (kind !== 'missing') writeFileSync(path, kind === 'malformed' ? '{' : JSON.stringify(kind === 'inconsistent' ? { ...result(), accuracy: 1 } : kind === 'empty' ? { ...result(), total: 0 } : result()));
  const r = readResult(path);
  expect(r.accuracy).toBe(kind === 'valid' ? 0.8 : 0);
  const h = harness(); expect((await decide(r, h.api, h.options)).exitCode).toBe(1);
  expect(h.api).toHaveBeenCalledWith('POST', '/issues', expect.objectContaining({ body: expect.stringContaining(marker) }));
});
it('uses the REST adapter with a bounded request and sanitized HTTP errors', async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  const api = githubApi('owner/repo', 'test-only', http);
  await api('GET', '/issues');
  expect(http).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/issues', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  http.mockResolvedValue(new Response('private upstream diagnostic', { status: 403 }));
  await expect(api('POST', '/issues', {})).rejects.toThrow(/^GitHub API HTTP 403$/);
});

// CI only. No runtime imports, persistent credentials, or response-body logging.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const threshold = 0.9;
export type Result = { total: number; passed: number; accuracy: number; failures: string[]; date: string };
export type Issue = { number: number; body: string | null; pull_request?: unknown };
export type Api = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<any>;
export type State = { issues: Issue[]; comments: Record<string, { body: string }[]>; labelExists: boolean };
export class ApiError extends Error { constructor(public status: number) { super(`GitHub API HTTP ${status}`); } }
export const taipeiDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function readResult(path: string): Result {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(r.total) || r.total <= 0 || !Number.isSafeInteger(r.passed) || r.passed < 0 || r.passed > r.total ||
      !Number.isFinite(r.accuracy) || Math.abs(r.accuracy - r.passed / r.total) > 1e-12 ||
      !Array.isArray(r.failures) || r.failures.some((s: unknown) => typeof s !== 'string') || r.failures.length !== r.total - r.passed ||
      typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw Error('invalid');
    return r;
  } catch { return { total: 0, passed: 0, accuracy: 0, failures: ['eval crashed, result missing or invalid'], date: '' }; }
}
export function githubApi(repo: string, token: string, http: typeof fetch = fetch): Api {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  return async (method, path, body) => {
    const response = await http(`https://api.github.com/repos/${repo}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response.status === 204 ? undefined : response.json();
  };
}
// Offline state is explicit: --dry-run defaults to no issue/label; --state supplies
// existing issues/comments to preview comment and skip-duplicate without any network.
export function offlineApi(state: State): Api {
  return async (method, path) => {
    if (method !== 'GET') throw Error('dry-run must not mutate');
    const url = new URL(path, 'https://offline.invalid');
    const page = Number(url.searchParams.get('page') ?? 1);
    if (url.pathname === '/labels/eval-regression') { if (!state.labelExists) throw new ApiError(404); return {}; }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(url.pathname);
    const rows = comments ? state.comments[comments[1]] ?? [] : state.issues;
    return rows.slice((page - 1) * 100, page * 100);
  };
}
async function pages<T>(api: Api, path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw Error('Invalid GitHub list response');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}
export async function decide(result: Result, api: Api, { now = new Date(), dryRun = false, log = console.log }: { now?: Date; dryRun?: boolean; log?: (s: string) => void } = {}) {
  if (result.accuracy >= threshold) { log(`pass: ${result.passed}/${result.total} >= 90%`); return { exitCode: 0, action: 'pass' }; }
  // Always use the current Taipei day, including crashes without a dated result.
  const date = taipeiDate(now), marker = `<!-- eval-regression:${date} -->`;
  const body = `${marker}\nDaily eval ${date}: ${result.passed}/${result.total} (${(result.accuracy * 100).toFixed(1)}%) below 90%.\nFailures: ${result.failures.join(', ')}\nResult date: ${result.date || 'unavailable'}`;
  const issue = (await pages<Issue>(api, '/issues?state=open&labels=eval-regression')).filter(i => !i.pull_request).sort((a, b) => a.number - b.number)[0];
  if (issue) {
    const comments = await pages<{ body: string | null }>(api, `/issues/${issue.number}/comments`);
    if ([issue, ...comments].some(c => c.body?.includes(marker))) {
      log(`skip-duplicate: issue #${issue.number} already records ${date}`);
      return { exitCode: 1, action: 'skip-duplicate' };
    }
    const path = `/issues/${issue.number}/comments`, payload = { body };
    log(`comment: POST ${path} ${JSON.stringify(payload)}`);
    if (!dryRun) await api('POST', path, payload);
    return { exitCode: 1, action: 'comment' };
  }
  let labelMissing = false;
  try { await api('GET', '/labels/eval-regression'); }
  catch (error) { if (error instanceof ApiError && error.status === 404) labelMissing = true; else throw error; }
  if (labelMissing) {
    const payload = { name: 'eval-regression', color: 'd73a4a', description: 'Daily evaluation accuracy below threshold' };
    log(`create-label: POST /labels ${JSON.stringify(payload)}`);
    if (!dryRun) await api('POST', '/labels', payload);
  }
  const payload = { title: 'Daily eval accuracy regression', labels: ['eval-regression'], body };
  log(`create: POST /issues ${JSON.stringify(payload)}`);
  if (!dryRun) await api('POST', '/issues', payload);
  return { exitCode: 1, action: 'create' };
}
async function main() {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const result = readResult(value('--result') ?? process.env.EVAL_RESULT_PATH ?? 'eval-result.json');
  // A passing run needs neither a token nor a GitHub request.
  const api = dryRun ? offlineApi(value('--state') ? JSON.parse(readFileSync(value('--state')!, 'utf8')) : { issues: [], comments: {}, labelExists: false })
    : result.accuracy >= threshold ? async () => { throw Error('unexpected API call'); } : githubApi(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_TOKEN ?? '');
  process.exitCode = (await decide(result, api, { dryRun })).exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('eval threshold check failed; unable to complete GitHub action'); process.exitCode = 1; });

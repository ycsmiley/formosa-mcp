import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps issue template fields and configuration valid', () => {
  const read = (name: string) => readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}.yml`, import.meta.url), 'utf8');
  const data = read('data-request');
  const bug = read('bug-report');
  const config = read('config');

  expect(data).toContain('labels: [data-request]');
  const fields = [...data.matchAll(/^    id: (\w+)\r?\n(?:(?!  - type:)[^\n]*\n)*?      required: (true|false)\s*$/gm)];
  expect(fields.map((match) => [match[1], match[2]])).toEqual([
    ['data', 'true'],
    ['use_case', 'true'],
    ['sources', 'false'],
    ['client', 'false'],
  ]);
  expect(bug).toContain('labels: [bug]');
  expect(config).toContain('blank_issues_enabled: false');
});

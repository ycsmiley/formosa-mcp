#!/usr/bin/env node
// Offline Swagger UI-style schema samples. Never requests the TDX service.
import { readFileSync } from 'node:fs';
const [file, path] = process.argv.slice(2);
if (!file || !path) throw new Error('Usage: node scripts/tdx-doc-examples.mjs <openapi.json> <path>');
const document = JSON.parse(readFileSync(file, 'utf8'));
const schema = document.paths[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
if (!schema) throw new Error('No JSON 200 response schema for this path');
function sample(schema, seen = new Set()) {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) throw new Error('Recursive schema');
    const target = schema.$ref.slice(2).split('/').reduce((v, key) => v[key.replaceAll('~1', '/').replaceAll('~0', '~')], document);
    return sample(target, new Set([...seen, schema.$ref]));
  }
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(s => sample(s, seen)), sample({ ...schema, allOf: undefined }, seen));
  if (schema.type === 'array') return [sample(schema.items, seen)];
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value, seen)]));
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'string') return 'string';
  return {};
}
console.log(JSON.stringify(sample(schema), null, 2));

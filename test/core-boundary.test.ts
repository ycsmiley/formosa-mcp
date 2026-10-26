import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
for (const layer of ['core', 'mcp']) {
  it(`${layer} stays runtime-agnostic`, () => {
    const paths = files(new URL(`../src/${layer}/`, import.meta.url));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      const filename = fileURLToPath(path);
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const name = specifier.text;
          const forbidden = name.startsWith('node:') || builtins.has(name)
            || (layer === 'core' && (name.startsWith('@modelcontextprotocol') || name.startsWith('zod')));
          expect(forbidden, `${filename}: forbidden import ${name}`).toBe(false);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      expect(source, filename).not.toMatch(/\bprocess\s*\.|\bBuffer\b/);
    }
  });
}

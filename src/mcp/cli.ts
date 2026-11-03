import { DEFAULT_TOOLSETS } from './toolsets.js';

export function parseToolsetsArg(argv: string[], available: readonly string[]): string[] {
  let selected: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') continue;
    let value: string;
    if (arg.startsWith('--toolsets=')) value = arg.slice('--toolsets='.length);
    else if (arg === '--toolsets') value = argv[++i] ?? '';
    else throw new Error(`未知參數 ${arg}。有效工具集：${available.join(', ')}`);
    const names = value.split(',').map(s => s.trim());
    for (const name of names) {
      if (!available.includes(name)) throw new Error(`未知工具集「${name}」。有效工具集：${available.join(', ')}`);
    }
    selected = [...new Set([...(selected ?? []), ...names])];
  }
  return selected ?? DEFAULT_TOOLSETS.filter(name => available.includes(name));
}

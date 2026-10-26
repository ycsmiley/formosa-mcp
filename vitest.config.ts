import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['test/worker/**', 'node_modules/**'] } });

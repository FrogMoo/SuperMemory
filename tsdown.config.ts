import { defineConfig } from 'tsdown'

// Host-half build. `@deepseek-ai/*` value imports never appear in src: host
// packages are loaded at runtime through the loadHostModule anchor pattern
// (createRequire(process.argv[1]).resolve) proven by dsh-vscode-mode, so the
// only static bare import left is schemastery, which resolves from the
// installing profile's node_modules exactly like dsh-vscode-mode does.
export default defineConfig({
  entry: { supermemory: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  shims: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: ['@deepseek-ai/*', 'zod'],
  },
})

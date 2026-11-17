import { defineConfig } from 'tsdown'

// Browser-half build: the client bundle the web GUI materializes through
// window.__ModuleLoader__.load({id, factory}). Only react stays external
// (a platform seed word); every @deepseek-ai/* import in src/client is
// type-only and erased. clean: false because the host build owns lib/.
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  shims: false,
  clean: false,
  splitting: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: ['react'],
  },
})

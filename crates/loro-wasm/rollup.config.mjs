import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const createConfig = (format, tsTarget, outputDir) => ({
  input: {
    'index': 'index.ts',
  },
  output: {
    dir: outputDir,
    format: format,
    sourcemap: true,
    entryFileNames: '[name].js',
  },
  plugins: [
    typescript({
      tsconfig: 'tsconfig.json',
      compilerOptions: {
        target: tsTarget,
        declaration: true,
        outDir: outputDir,
      },
      exclude: ['tests/**/*', 'vite.config.*']
    }),
    nodeResolve()
  ],
  external: [/loro_wasm/]
});

// When LORO_WASM_JSONPATH=1 the `loro-crdt/jsonpath` subpath artifact is
// emitted under `jsonpath/`; otherwise the lean default package targets.
const outPrefix = process.env.LORO_WASM_JSONPATH === '1' ? 'jsonpath/' : '';

// Create different bundle configurations
export default [
  // CommonJS for Node.js
  createConfig('cjs', 'ES2020', outPrefix + 'nodejs'),

  // ESM for Web
  createConfig('es', 'ES2020', outPrefix + 'web'),

  // ESM for browser bundlers that do not support top-level await.
  createConfig('es', 'ES2020', outPrefix + 'browser'),

  // ESM for bundler
  createConfig('es', 'ES2020', outPrefix + 'bundler'),
];

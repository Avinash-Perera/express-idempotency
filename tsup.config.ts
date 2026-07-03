import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'stores/index': 'src/stores/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  external: ['express', 'ioredis'],
});

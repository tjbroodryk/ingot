import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', duckdb: 'src/duckdb/index.ts' },
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'neutral',
  // `@ingot/shared` is private, so its enums and types have to ship inside this
  // package. `tsconfig.json` points the import at its source.
  noExternal: ['@ingot/shared/ingot-v1'],
  dts: { resolve: true },
  splitting: false,
  // Maps would point into a monorepo the consumer does not have.
  sourcemap: false,
  clean: true,
  treeshake: true,
});

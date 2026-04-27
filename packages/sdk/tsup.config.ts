import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	target: 'node20',
	platform: 'neutral',
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	splitting: false,
	minify: false,
	noExternal: ['@maskin/shared'],
	external: ['openapi-fetch'],
	outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
})

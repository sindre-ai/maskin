import { build } from 'esbuild'

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	banner: {
		js: "import { createRequire as __createBannerRequire } from 'module'; const require = __createBannerRequire(import.meta.url);",
	},
})

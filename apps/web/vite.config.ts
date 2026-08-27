import faroUploader from '@grafana/faro-rollup-plugin'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Source-map upload to Grafana Faro. A minified stack trace is close to
// useless, and the existing Sentry setup never wired uploads at all — so this
// is new ground rather than a pattern to follow.
//
// All four values are build-time only and deliberately NOT `VITE_`-prefixed:
// FARO_API_KEY is a Grafana Cloud access-policy token with `sourcemaps:write`
// and is a real secret. It must never reach the bundle. (The *runtime*
// VITE_FARO_URL app key is a different thing and is public by design.)
const faroSourcemapUpload = {
	endpoint: process.env.FARO_SOURCEMAP_ENDPOINT,
	appId: process.env.FARO_APP_ID,
	stackId: process.env.FARO_STACK_ID,
	apiKey: process.env.FARO_API_KEY,
}
const uploadConfigured = Object.values(faroSourcemapUpload).every(Boolean)

export default defineConfig({
	plugins: [
		TanStackRouterVite({ quoteStyle: 'single' }),
		react(),
		tailwindcss(),
		...(uploadConfigured
			? [
					faroUploader({
						// biome-ignore lint/style/noNonNullAssertion: guarded by uploadConfigured
						endpoint: faroSourcemapUpload.endpoint!,
						// biome-ignore lint/style/noNonNullAssertion: guarded by uploadConfigured
						appId: faroSourcemapUpload.appId!,
						// biome-ignore lint/style/noNonNullAssertion: guarded by uploadConfigured
						stackId: faroSourcemapUpload.stackId!,
						// biome-ignore lint/style/noNonNullAssertion: guarded by uploadConfigured
						apiKey: faroSourcemapUpload.apiKey!,
						// Must match FARO_APP_NAME in src/lib/faro.ts. The plugin stamps a
						// bundle id into the build under a global keyed by this name and
						// the SDK reads it back to match a stack trace to its map — a
						// mismatch means uploads succeed and traces stay minified.
						appName: 'maskin-web',
						outputFiles: ['*.js'],
						// Leave no .map files in dist/. apps/dev serves dist/ statically
						// (STATIC_DIR), so a kept map would be publicly fetchable.
						keepSourcemaps: false,
						gzipContents: true,
					}),
				]
			: []),
	],
	build: {
		// 'hidden' emits the .map files the uploader needs without leaving a
		// //# sourceMappingURL comment pointing at them. Only enabled when the
		// uploader will consume and delete them — otherwise a build would drop
		// readable maps into a publicly served directory for nothing.
		sourcemap: uploadConfigured ? 'hidden' : false,
	},
	resolve: {
		alias: {
			'@': '/src',
		},
	},
	server: {
		port: 5173,
		// Only bind every interface when the sandboxed dev-external bootstrap asks
		// for it (so the msb bridge/preview-port forwarding can reach this dev
		// server) — ordinary `pnpm dev`/`pnpm dev:win` stays loopback-only.
		host: process.env.MASKIN_DEV_EXTERNAL === '1' ? '0.0.0.0' : 'localhost',
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				changeOrigin: true,
			},
			'/mcp': {
				target: 'http://localhost:3000',
				changeOrigin: true,
			},
		},
	},
})

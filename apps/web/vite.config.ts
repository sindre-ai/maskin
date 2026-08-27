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

// `@grafana/faro-rollup-plugin` is imported lazily, and ONLY when the upload is
// configured, because it is not loadable on the Node version we build on:
//
//   faro-rollup-plugin -> @grafana/faro-bundlers-shared -> undici@^8.1.0
//
// and undici 8 declares `engines.node >= 22.19.0`. CI and apps/dev/Dockerfile
// both run Node 20 (`FROM node:20-alpine`), where requiring it dies at import
// time with `webidl.util.markAsUncloneable is not a function`. A top-level
// import therefore breaks *every* build — including the production image —
// whether or not source-map upload is switched on. Behind this gate, a build
// with no upload credentials never loads it at all.
//
// This does mean enabling the upload requires Node >= 22 for the build. That
// is asserted below rather than left to a cryptic undici stack trace.
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (uploadConfigured && NODE_MAJOR < 22) {
	throw new Error(
		[
			'Faro source-map upload is configured but requires Node >= 22 to build',
			'(@grafana/faro-rollup-plugin depends on undici@8, engines.node >= 22.19.0);',
			`this build is running Node ${process.versions.node}.`,
			'Either upgrade the builder (apps/dev/Dockerfile is FROM node:20-alpine)',
			'or unset FARO_SOURCEMAP_ENDPOINT / FARO_APP_ID / FARO_STACK_ID / FARO_API_KEY',
			'to build without source maps.',
		].join(' '),
	)
}

export default defineConfig(async () => ({
	plugins: [
		TanStackRouterVite({ quoteStyle: 'single' }),
		react(),
		tailwindcss(),
		...(uploadConfigured
			? [
					(await import('@grafana/faro-rollup-plugin')).default({
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
}))

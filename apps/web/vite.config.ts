import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [TanStackRouterVite({ quoteStyle: 'single' }), react(), tailwindcss()],
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

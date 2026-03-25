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

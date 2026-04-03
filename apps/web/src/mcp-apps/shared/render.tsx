import '@/app.css'
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { McpAppProvider } from './mcp-app-provider'

export function renderMcpApp(name: string, children: ReactNode) {
	// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed in index.html
	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<McpAppProvider name={name}>{children}</McpAppProvider>
		</StrictMode>,
	)
}

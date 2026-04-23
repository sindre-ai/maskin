/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'
import type { WorkspaceWithRole } from '@/lib/api'
import { SindreProvider } from '@/lib/sindre-context'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'
import { buildWorkspaceWithRole } from './factories'

// Radix primitives call pointer-capture APIs that jsdom doesn't implement.
if (typeof Element !== 'undefined') {
	if (!Element.prototype.hasPointerCapture) {
		Element.prototype.hasPointerCapture = () => false
	}
	if (!Element.prototype.releasePointerCapture) {
		Element.prototype.releasePointerCapture = () => {}
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {}
	}
}

export function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: 0,
			},
			mutations: {
				retry: false,
			},
		},
	})
}

export function createTestWrapper() {
	const queryClient = createTestQueryClient()
	return ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
}

export function TestWrapper({ children }: { children: ReactNode }) {
	const [queryClient] = React.useState(() => createTestQueryClient())
	return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

export function createWorkspaceWrapper(overrides: Partial<WorkspaceWithRole> = {}) {
	const workspace = buildWorkspaceWithRole(overrides)
	const ctxValue: WorkspaceContextValue = {
		workspace,
		workspaceId: workspace.id,
		sseStatus: 'connected',
	}
	return ({ children }: { children: ReactNode }) =>
		React.createElement(
			QueryClientProvider,
			{ client: createTestQueryClient() },
			React.createElement(
				WorkspaceContext.Provider,
				{ value: ctxValue },
				React.createElement(SindreProvider, { workspaceId: workspace.id, children }),
			),
		)
}

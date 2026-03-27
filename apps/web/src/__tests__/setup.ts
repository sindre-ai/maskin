/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

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

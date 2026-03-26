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

export function TestWrapper({ children }: { children: ReactNode }) {
	const queryClient = createTestQueryClient()
	return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

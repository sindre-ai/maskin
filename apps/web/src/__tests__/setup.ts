/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'
import type { WorkspaceWithRole } from '@/lib/api'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
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

// Defensive polyfill: on some Node/jsdom/vitest version combinations,
// `globalThis.localStorage` can come back `undefined` in the test environment (a global
// storage getter shadowing jsdom's own implementation), which makes any module that
// touches storage at import time throw. Where that happens, install a spec-shaped
// in-memory Storage instead. This is a no-op when jsdom's storage is already present,
// which is the common case — it's exported and covered directly by
// `storage-polyfill.test.ts` since the failure condition doesn't reproduce in every
// environment (notably not in this repo's CI, which pins Node 20), so nothing else
// exercises this branch.
export function installStoragePolyfill(
	target: { localStorage?: Storage; sessionStorage?: Storage } = globalThis,
) {
	if (typeof target.localStorage !== 'undefined') return
	const makeStorage = (): Storage => {
		const store = new Map<string, string>()
		return {
			get length() {
				return store.size
			},
			key: (i: number) => [...store.keys()][i] ?? null,
			getItem: (k: string) => store.get(String(k)) ?? null,
			setItem: (k: string, v: string) => {
				store.set(String(k), String(v))
			},
			removeItem: (k: string) => {
				store.delete(String(k))
			},
			clear: () => store.clear(),
		} as Storage
	}
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		Object.defineProperty(target, name, {
			value: makeStorage(),
			configurable: true,
			writable: true,
		})
	}
}
installStoragePolyfill()

// Radix's `react-use-size` (used by Switch + others) reads ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// jsdom doesn't ship matchMedia; `useIsMobile()` calls it on mount. Default to
// the non-matching (desktop) branch so existing component tests keep their
// pre-mobile-collapse behaviour. Tests asserting mobile branches mock
// `@/hooks/use-mobile` directly.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
	window.matchMedia = (() =>
		({
			matches: false,
			media: '',
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList) as typeof window.matchMedia
}

// jsdom doesn't ship IntersectionObserver; stub a no-op so lazy-load and
// visibility-gated hooks don't crash. Tests that need to drive intersections
// should override this global locally.
if (typeof globalThis.IntersectionObserver === 'undefined') {
	class IntersectionObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return []
		}
	}
	globalThis.IntersectionObserver =
		IntersectionObserverStub as unknown as typeof IntersectionObserver
}

// jsdom doesn't ship matchMedia; useIsMobile() reads it on every mount.
// Default to a non-matching desktop viewport; tests can override locally.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
	window.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList
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

/**
 * Stands in for the app shell's nav row: renders whatever the page under test
 * published through `PageHeader` (its crumb label and its actions). Opt in via
 * `createWorkspaceWrapper(overrides, { renderPageHeader: true })` when the
 * assertions cover controls the page publishes rather than renders itself.
 */
function PageHeaderOutlet({ children }: { children: ReactNode }) {
	const { crumb, actions } = usePageHeader()
	return React.createElement(
		React.Fragment,
		null,
		React.createElement('header', null, crumb ? crumb.label : null, actions),
		children,
	)
}

export function createWorkspaceWrapper(
	overrides: Partial<WorkspaceWithRole> = {},
	{ renderPageHeader = false }: { renderPageHeader?: boolean } = {},
) {
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
				renderPageHeader
					? React.createElement(
							PageHeaderProvider,
							null,
							React.createElement(PageHeaderOutlet, null, children),
						)
					: children,
			),
		)
}

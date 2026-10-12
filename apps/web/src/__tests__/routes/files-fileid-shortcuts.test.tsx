import { act, render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pull the page component off the mocked createFileRoute, same shape as
// loops-detail.test.tsx.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			fullPath: '/_authed/$workspaceId/files/$fileId',
			useParams: () => ({ fileId: 'file-1' }),
			useSearch: () => ({}),
		}),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsDesktopViewport: () => true,
}))
vi.mock('@/hooks/use-files', () => ({
	useFile: () => ({
		data: { id: 'file-1', name: 'deck.html', encoding: 'utf8', content: '<html></html>' },
		isLoading: false,
		error: null,
	}),
}))
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/hooks/use-attaching-objects', () => ({ useAttachingObjects: () => ({ data: [] }) }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-file-comments', () => ({
	useFileComments: () => ({ data: [] }),
	useCreateFileComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateFileComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSendFileCommentsRound: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/hooks/use-viewer-preferences', () => ({
	useViewerPreferences: () => ({
		variantOverride: 'auto',
		mockupPreset: 'desktop',
		setVariantOverride: vi.fn(),
		setMockupPreset: vi.fn(),
	}),
}))
vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/files/provenance-strip', () => ({ ProvenanceStrip: () => null }))
vi.mock('@/components/files/viewer-stage', () => ({ ViewerStage: () => null }))
vi.mock('@/components/objects/linked-objects', () => ({ LinkedObjectsForFile: () => null }))
vi.mock('@/components/files/review-panel', () => ({
	ReviewPanel: () => <div data-testid="review-panel" />,
}))

import { Route } from '@/routes/_authed/$workspaceId/files/$fileId'

function renderRoute() {
	const Component = (Route as unknown as { component: React.ComponentType }).component
	return render(<Component />)
}

function press(init: KeyboardEventInit) {
	act(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
	})
}

describe('files/$fileId C shortcut', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('toggles the review panel on a plain C', () => {
		renderRoute()
		expect(screen.queryByTestId('review-panel')).toBeNull()
		press({ key: 'c' })
		expect(screen.getByTestId('review-panel')).toBeTruthy()
		press({ key: 'C' })
		expect(screen.queryByTestId('review-panel')).toBeNull()
	})

	it('leaves a plain C alone while text is selected', () => {
		renderRoute()
		const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
			toString: () => 'copy me',
		} as Selection)
		press({ key: 'c' })
		expect(screen.queryByTestId('review-panel')).toBeNull()
		selection.mockRestore()
	})

	it('ignores C typed into a text input', () => {
		renderRoute()
		const input = document.createElement('input')
		document.body.appendChild(input)
		act(() => {
			input.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }),
			)
		})
		expect(screen.queryByTestId('review-panel')).toBeNull()
		input.remove()
	})

	it.each([
		['Cmd+C', { key: 'c', metaKey: true }],
		['Ctrl+C', { key: 'c', ctrlKey: true }],
		['Alt+C', { key: 'c', altKey: true }],
	])('leaves %s alone so the browser can copy', (_label, init) => {
		renderRoute()
		const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
		act(() => {
			window.dispatchEvent(event)
		})
		expect(screen.queryByTestId('review-panel')).toBeNull()
		expect(event.defaultPrevented).toBe(false)
	})
})

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseSearch = vi.fn()
const mockPostMessage = vi.fn()
const mockClose = vi.fn()
const mockReplace = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockUseSearch(),
		}),
	}
})

import { POST_MESSAGE_TYPE, Route } from '@/routes/oauth-return'

const OauthReturnPage = (Route as unknown as { component: React.FC }).component

describe('OauthReturnPage', () => {
	let originalLocation: Location

	beforeEach(() => {
		vi.clearAllMocks()
		originalLocation = window.location
		// Make `window.location.replace` mockable.
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...originalLocation,
				replace: mockReplace,
			},
		})
		Object.defineProperty(window, 'close', {
			configurable: true,
			value: mockClose,
		})
	})

	afterEach(() => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
		Object.defineProperty(window, 'opener', {
			configurable: true,
			value: null,
		})
	})

	it('postMessages the opener and closes when running in a popup', () => {
		Object.defineProperty(window, 'opener', {
			configurable: true,
			value: { postMessage: mockPostMessage },
		})
		mockUseSearch.mockReturnValue({
			provider: 'github',
			workspace_id: 'ws-1',
			status: 'success',
		})

		render(<OauthReturnPage />)

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: POST_MESSAGE_TYPE,
				provider: 'github',
				workspaceId: 'ws-1',
				status: 'success',
			}),
			'*',
		)
		expect(mockClose).toHaveBeenCalled()
		expect(mockReplace).not.toHaveBeenCalled()
	})

	it('redirects to /:workspaceId/settings/integrations when not running in a popup', () => {
		Object.defineProperty(window, 'opener', {
			configurable: true,
			value: null,
		})
		mockUseSearch.mockReturnValue({
			provider: 'github',
			workspace_id: 'ws-1',
			status: 'success',
		})

		render(<OauthReturnPage />)

		expect(mockReplace).toHaveBeenCalledWith('/ws-1/settings/integrations?status=success')
		expect(mockClose).not.toHaveBeenCalled()
	})

	it('forwards error_code through both branches', () => {
		Object.defineProperty(window, 'opener', {
			configurable: true,
			value: null,
		})
		mockUseSearch.mockReturnValue({
			provider: 'github',
			workspace_id: 'ws-1',
			status: 'error',
			error_code: 'token_exchange_failed',
		})

		render(<OauthReturnPage />)

		expect(mockReplace).toHaveBeenCalledWith(
			'/ws-1/settings/integrations?status=error&error=token_exchange_failed',
		)
	})

	it('falls back to the static "you can close this window" view when no workspace is given', () => {
		Object.defineProperty(window, 'opener', {
			configurable: true,
			value: null,
		})
		mockUseSearch.mockReturnValue({})

		render(<OauthReturnPage />)

		expect(screen.getByText(/can close this window/i)).toBeInTheDocument()
	})
})

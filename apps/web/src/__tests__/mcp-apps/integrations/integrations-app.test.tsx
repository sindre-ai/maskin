import {
	IntegrationsListView,
	OAUTH_RETURN_TIMEOUT_MS,
	POPUP_MESSAGE_TYPE,
	ProviderRow,
	waitForOauthReturn,
} from '@/mcp-apps/integrations/integrations-app'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callTool = vi.fn()
const useToolResultMock = vi.fn(() => ({
	webAppBaseUrl: 'https://app.maskin.example.com',
	workspaceId: 'ws-1',
}))

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useCallTool: () => callTool,
	useToolResult: () => useToolResultMock(),
	useWebAppContext: () => {
		const tr = useToolResultMock()
		if (!tr?.webAppBaseUrl || !tr.workspaceId) return null
		return { baseUrl: tr.webAppBaseUrl, workspaceId: tr.workspaceId }
	},
}))

const textResult = (data: unknown) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(data) }],
})

beforeEach(() => {
	callTool.mockReset()
	useToolResultMock.mockReset()
	useToolResultMock.mockReturnValue({
		webAppBaseUrl: 'https://app.maskin.example.com',
		workspaceId: 'ws-1',
	})
})

describe('IntegrationsListView', () => {
	it('renders the empty state when no providers and no integrations are available', async () => {
		callTool.mockImplementation(async (name: string) => {
			if (name === 'list_integrations') return textResult([])
			if (name === 'list_integration_providers') return textResult([])
			return textResult([])
		})
		render(<IntegrationsListView initialIntegrations={[]} />)
		await waitFor(() => {
			expect(screen.getByText('No providers available')).toBeInTheDocument()
		})
	})

	it('lists provider rows from initialProviders and labels Connect when no integration is active', async () => {
		callTool.mockResolvedValueOnce(textResult([])) // list_integrations fetch
		render(
			<IntegrationsListView
				initialProviders={[
					{ name: 'github', displayName: 'GitHub', events: [] },
					{
						name: 'slack',
						displayName: 'Slack',
						events: [{ entityType: 'message', actions: ['created'], label: 'Message' }],
					},
				]}
			/>,
		)
		await waitFor(() => {
			expect(screen.getByText('GitHub')).toBeInTheDocument()
		})
		expect(screen.getByText('Slack')).toBeInTheDocument()
		expect(screen.getAllByRole('button', { name: /connect/i })).toHaveLength(2)
		expect(screen.getByText(/1 event types available/i)).toBeInTheDocument()
	})

	it('shows "Disconnect" for providers that have an active integration', async () => {
		callTool.mockResolvedValueOnce(
			textResult([{ id: 'i-1', provider: 'github', status: 'active', externalId: 'octocat' }]),
		)
		render(
			<IntegrationsListView
				initialProviders={[{ name: 'github', displayName: 'GitHub', events: [] }]}
			/>,
		)
		await waitFor(() => {
			expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
		})
		expect(screen.getByText(/Connected · octocat/i)).toBeInTheDocument()
	})
})

describe('ProviderRow', () => {
	const provider = { name: 'github', displayName: 'GitHub', events: [] }

	it('shows "Connect" when no integration is connected', () => {
		render(<ProviderRow provider={provider} onChanged={async () => undefined} />)
		expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument()
	})

	it('shows "Disconnect" when an integration is provided', () => {
		render(
			<ProviderRow
				provider={provider}
				integration={{ id: 'i-1', provider: 'github', status: 'active' }}
				onChanged={async () => undefined}
			/>,
		)
		expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
	})

	it('opens an OAuth popup, refreshes on success message, and clears busy state', async () => {
		const popup = { closed: false, close: vi.fn() } as unknown as Window
		const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup)
		callTool.mockResolvedValueOnce(textResult({ install_url: 'https://example.com/oauth' }))
		const onChanged = vi.fn().mockResolvedValue(undefined)

		render(<ProviderRow provider={provider} onChanged={onChanged} />)
		fireEvent.click(screen.getByRole('button', { name: /connect/i }))

		await waitFor(() => expect(openSpy).toHaveBeenCalled())
		expect(openSpy).toHaveBeenCalledWith(
			'https://example.com/oauth',
			'maskin-oauth',
			expect.stringContaining('width=600'),
		)
		expect(callTool).toHaveBeenCalledWith('connect_integration', { provider: 'github' })

		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-1',
					status: 'success',
					errorCode: null,
				},
				origin: 'https://app.maskin.example.com',
				source: popup,
			}),
		)

		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		openSpy.mockRestore()
	})

	it('surfaces a user-facing error when the popup is blocked', async () => {
		const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
		callTool.mockResolvedValueOnce(textResult({ install_url: 'https://example.com/oauth' }))
		const onChanged = vi.fn()

		render(<ProviderRow provider={provider} onChanged={onChanged} />)
		fireEvent.click(screen.getByRole('button', { name: /connect/i }))

		await waitFor(() => expect(screen.getByText(/popup blocked/i)).toBeInTheDocument())
		expect(onChanged).not.toHaveBeenCalled()
		openSpy.mockRestore()
	})

	it('surfaces the server error text when connect returns isError', async () => {
		callTool.mockResolvedValueOnce({
			isError: true,
			content: [
				{
					type: 'text',
					text: 'API error 400: Provider slack is not configured on this server: SLACK_CLIENT_ID environment variable is required',
				},
			],
		})
		const onChanged = vi.fn()
		render(<ProviderRow provider={provider} onChanged={onChanged} />)
		fireEvent.click(screen.getByRole('button', { name: /connect/i }))

		await waitFor(() => expect(screen.getByText(/SLACK_CLIENT_ID/i)).toBeInTheDocument())
		expect(onChanged).not.toHaveBeenCalled()
	})

	it('disconnects via callTool and refreshes', async () => {
		callTool.mockResolvedValueOnce(textResult({ ok: true }))
		const onChanged = vi.fn().mockResolvedValue(undefined)
		render(
			<ProviderRow
				provider={provider}
				integration={{ id: 'i-1', provider: 'github', status: 'active' }}
				onChanged={onChanged}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
		await waitFor(() => {
			expect(callTool).toHaveBeenCalledWith('disconnect_integration', { id: 'i-1' })
		})
		expect(onChanged).toHaveBeenCalled()
	})
})

describe('waitForOauthReturn', () => {
	let popup: Window
	const expectedOrigin = 'https://app.maskin.example.com'

	beforeEach(() => {
		popup = { closed: false, close: vi.fn() } as unknown as Window
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('resolves with success when a valid message arrives', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-1',
					status: 'success',
					errorCode: null,
				},
				origin: expectedOrigin,
				source: popup,
			}),
		)
		await expect(promise).resolves.toEqual({ status: 'success', errorCode: null })
	})

	it('drops messages from a different origin', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-1',
					status: 'success',
				},
				origin: 'https://evil.example.com',
				source: popup,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('drops messages from a different window source', async () => {
		const otherWindow = { closed: false, close: vi.fn() } as unknown as Window
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-1',
					status: 'success',
				},
				origin: expectedOrigin,
				source: otherWindow,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('fails closed when expectedOrigin is null', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin: null,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-1',
					status: 'success',
				},
				origin: expectedOrigin,
				source: popup,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('drops messages with a missing provider', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: null,
					workspaceId: 'ws-1',
					status: 'success',
				},
				origin: expectedOrigin,
				source: popup,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('drops messages with a missing workspaceId when expected', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: null,
					status: 'success',
				},
				origin: expectedOrigin,
				source: popup,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('drops messages with a mismatched workspaceId', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: 1000,
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: POPUP_MESSAGE_TYPE,
					provider: 'github',
					workspaceId: 'ws-other',
					status: 'success',
				},
				origin: expectedOrigin,
				source: popup,
			}),
		)
		await act(async () => {
			vi.advanceTimersByTime(1001)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
	})

	it('resolves with closed when the popup is dismissed', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
		})
		Object.defineProperty(popup, 'closed', { value: true, configurable: true })
		await act(async () => {
			vi.advanceTimersByTime(600)
		})
		await expect(promise).resolves.toEqual({ status: 'closed' })
	})

	it('resolves with timeout and closes the popup when timeoutMs elapses', async () => {
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			timeoutMs: OAUTH_RETURN_TIMEOUT_MS,
		})
		await act(async () => {
			vi.advanceTimersByTime(OAUTH_RETURN_TIMEOUT_MS + 1)
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'timeout' })
		expect(popup.close).toHaveBeenCalled()
	})

	it('resolves with aborted when the AbortSignal fires', async () => {
		const ctrl = new AbortController()
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			signal: ctrl.signal,
		})
		ctrl.abort()
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'aborted' })
		expect(popup.close).toHaveBeenCalled()
	})

	it('resolves immediately if the signal is already aborted', async () => {
		const ctrl = new AbortController()
		ctrl.abort()
		const promise = waitForOauthReturn({
			popup,
			expectedOrigin,
			expectedProvider: 'github',
			expectedWorkspaceId: 'ws-1',
			signal: ctrl.signal,
		})
		await expect(promise).resolves.toEqual({ status: 'closed', errorCode: 'aborted' })
	})
})

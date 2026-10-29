import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const sessionsState = vi.hoisted(() => ({
	data: [] as Array<{ id: string; actorId: string; status: string }>,
}))
const mockMutateAsync = vi.hoisted(() => vi.fn())
const chatCaptureMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})
vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
	useConversation: () => ({
		data: { participants: [{ actorId: 'agent-1', actorName: 'Infra' }] },
	}),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))
vi.mock('@/hooks/use-sessions', async () => {
	const actual =
		await vi.importActual<typeof import('@/hooks/use-sessions')>('@/hooks/use-sessions')
	return { ...actual, useActiveSessionsForConversation: () => ({ data: sessionsState.data }) }
})
vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return {
		...actual,
		useActors: () => ({ data: [{ id: 'agent-1', name: 'Infra', type: 'agent' }] }),
	}
})
vi.mock('@/hooks/use-conversations', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-conversations')>(
		'@/hooks/use-conversations',
	)
	return { ...actual, useConversationsInfinite: () => ({ data: { pages: [] } }) }
})
vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			integrations: { ...actual.api.integrations, chatCapture: chatCaptureMock },
		},
	}
})

// Obviously fake, assembled at runtime so no token-shaped literal sits in the repo.
const FAKE_TOKEN = `Zq7${'K3x'.repeat(10)}`

function storageHolds(needle: string) {
	for (const store of [sessionStorage, localStorage]) {
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i) as string
			if (key.includes(needle) || (store.getItem(key) ?? '').includes(needle)) return true
		}
	}
	return false
}

async function pasteIntoThread() {
	const user = userEvent.setup()
	render(<ThreadComposer workspaceId="ws-test" conversationId="convo-1" />, {
		wrapper: createWorkspaceWrapper(),
	})
	await user.click(screen.getByLabelText('Message this conversation'))
	await user.paste(`!${FAKE_TOKEN}`)
	await screen.findByLabelText('Secret to vault')
	return user
}

beforeEach(() => {
	sessionStorage.clear()
	localStorage.clear()
	mockMutateAsync.mockReset()
	chatCaptureMock.mockReset()
	sessionsState.data = [{ id: 'sess-1', actorId: 'agent-1', status: 'running' }]
})

describe('ThreadComposer — vault mode (the ! prefix)', () => {
	it('sends no message while the secret is typed, and keeps the token out of storage', async () => {
		await pasteIntoThread()

		expect(mockMutateAsync).not.toHaveBeenCalled()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
		expect(screen.getByRole('button', { name: 'Vault →' })).toBeEnabled()
	})

	it('vaults into the running session and posts only the marker', async () => {
		chatCaptureMock.mockResolvedValue({
			integrationId: 'int-1',
			undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			undoUrl: '/api/integrations/int-1/undo',
			relaunch: 'stopped',
		})
		mockMutateAsync.mockResolvedValue({})
		const user = await pasteIntoThread()
		await user.click(screen.getByRole('button', { name: 'Vault →' }))
		await user.type(await screen.findByLabelText('Credential name'), 'Coolify')
		await user.type(screen.getByLabelText('Service'), 'Coolify')
		await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))

		await waitFor(() => expect(chatCaptureMock).toHaveBeenCalledTimes(1))
		expect(chatCaptureMock).toHaveBeenCalledWith(
			'ws-test',
			expect.objectContaining({
				sessionId: 'sess-1',
				detectedProvider: 'manual',
				rawSecret: FAKE_TOKEN,
			}),
		)
		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))
		const sent = mockMutateAsync.mock.calls[0]?.[0] as { content: string }
		expect(sent.content).toBe('[REDACTED · vaulted as Coolify · env KEYCHAIN_BYO_APIKEY_COOLIFY]')
		expect(JSON.stringify(mockMutateAsync.mock.calls)).not.toContain(FAKE_TOKEN)
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
	})

	it.each([
		['no session at all', [] as Array<{ id: string; actorId: string; status: string }>],
		['a session that is still starting', [{ id: 's', actorId: 'agent-1', status: 'starting' }]],
		['a session that is pending', [{ id: 's', actorId: 'agent-1', status: 'pending' }]],
		['a session that is queued', [{ id: 's', actorId: 'agent-1', status: 'queued' }]],
	])('waits with the helper line when the conversation has %s', async (_label, sessions) => {
		sessionsState.data = sessions
		await pasteIntoThread()

		expect(screen.getByRole('button', { name: 'Vault →' })).toBeDisabled()
		expect(
			screen.getByText(/Messages still send\. Vaulting another secret waits until/),
		).toBeInTheDocument()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(mockMutateAsync).not.toHaveBeenCalled()
	})
})

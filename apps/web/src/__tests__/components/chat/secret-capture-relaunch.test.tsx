import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const chatCaptureMock = vi.hoisted(() => vi.fn())
const undoMock = vi.hoisted(() => vi.fn())
const relaunchMock = vi.hoisted(() => vi.fn())
const logsMock = vi.hoisted(() => vi.fn())
const sessionsStore = vi.hoisted(() => {
	let list: Array<{ id: string; actorId: string; status: string }> = []
	const subs = new Set<() => void>()
	return {
		get: () => list,
		set: (next: typeof list) => {
			list = next
			for (const f of subs) f()
		},
		subscribe: (f: () => void) => {
			subs.add(f)
			return () => subs.delete(f)
		},
	}
})

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'keychain-chat-capture',
}))
vi.mock('@/components/chat/slash-picker', () => ({ SlashPicker: () => null }))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
	trackChatMentionInserted: () => {},
	trackEvent: () => {},
}))
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
vi.mock('@/hooks/use-sessions', async () => {
	const actual =
		await vi.importActual<typeof import('@/hooks/use-sessions')>('@/hooks/use-sessions')
	const { useSyncExternalStore } = await import('react')
	return {
		...actual,
		useActiveSessionsForConversation: () => ({
			data: useSyncExternalStore(sessionsStore.subscribe, sessionsStore.get),
		}),
	}
})
vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			integrations: {
				...actual.api.integrations,
				chatCapture: chatCaptureMock,
				undo: undoMock,
				relaunch: relaunchMock,
			},
			sessions: { ...actual.api.sessions, logs: logsMock },
		},
	}
})

// Obviously fake, assembled at runtime so no token-shaped literal sits in the repo.
const FAKE_CF = `cfut_${'Zq7'.repeat(14)}`
const capture = {
	sessionId: 'sess-old',
	conversationId: 'conv-1',
	agent: { id: 'agent-1', name: 'Infra' },
}

function renderComposer(
	overrides: Partial<Parameters<typeof Composer>[0]> = {},
	onSend = vi.fn().mockResolvedValue(undefined),
) {
	const props = {
		workspaceId: 'ws-test',
		onSend,
		disabled: false,
		pending: false,
		surface: 'sheet' as const,
		placeholder: 'Message',
		selection: EMPTY_CHAT_SELECTION,
		onDispatchSelection: vi.fn(),
		onRemoveAgent: vi.fn(),
		onRemoveObject: vi.fn(),
		onRemoveNotification: vi.fn(),
		onRemoveFile: vi.fn(),
		draftKey: 'conv-1',
		secretCapture: capture,
		...overrides,
	}
	render(<Composer {...props} />, { wrapper: createWorkspaceWrapper() })
	return props
}

/** Paste the fake key, send, and walk the card through scope to the vault button. */
async function vault(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('textbox'))
	await user.paste(`use ${FAKE_CF} please`)
	await user.keyboard('{Enter}')
	await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))
	await user.click(await screen.findByRole('button', { name: /Vault \+ continue chat/ }))
}

function deferred<T>() {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const vaulted = (relaunch: 'stopped' | 'failed', id = 'int-1') => ({
	integrationId: id,
	undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
	undoUrl: `/api/integrations/${id}/undo`,
	relaunch,
})
const MARKER = 'use cfut_[REDACTED · vaulted as Cloudflare key] please'
const RESUMING = 'Resuming with the new credential…'
const FAILED = /Couldn't restart Infra\. The credential is saved, but the session is still running/

beforeEach(() => {
	sessionStorage.clear()
	chatCaptureMock.mockReset()
	undoMock.mockReset()
	relaunchMock.mockReset()
	logsMock.mockReset().mockResolvedValue([])
	sessionsStore.set([{ id: 'sess-old', actorId: 'agent-1', status: 'running' }])
})

describe('7c-1: resuming after a vault', () => {
	it('posts the marker after the stop, then shows the Resuming state with a Restarting pill', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		const props = renderComposer()
		await vault(userEvent.setup())

		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(MARKER))
		expect(await screen.findByText(RESUMING)).toBeInTheDocument()
		expect(screen.getByText('Restarting Infra. Your messages still send.')).toBeInTheDocument()
		expect(screen.getByText('Restarting')).toBeInTheDocument()
		expect(screen.queryByText('Live')).not.toBeInTheDocument()
		// The status row is a polite live region, so it is announced once.
		expect(screen.getByText(RESUMING).closest('output')).toHaveAttribute('aria-live', 'polite')
		// Undo stays tappable while resuming.
		expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
	})

	it('clears on the first output line of the new session and reads Live', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		logsMock.mockResolvedValue([{ id: 1, sessionId: 'sess-new', stream: 'stdout', content: '{}' }])
		renderComposer()
		await vault(userEvent.setup())
		expect(await screen.findByText(RESUMING)).toBeInTheDocument()

		// The old session ends and the responder's respawn shows up as a session we have not seen.
		act(() =>
			sessionsStore.set([
				{ id: 'sess-old', actorId: 'agent-1', status: 'user_stopped' },
				{ id: 'sess-new', actorId: 'agent-1', status: 'running' },
			]),
		)

		await waitFor(() => expect(screen.queryByText(RESUMING)).not.toBeInTheDocument())
		expect(logsMock).toHaveBeenCalledWith('sess-new', 'ws-test', { stream: 'stdout', limit: '1' })
		expect(screen.getByText('Live')).toBeInTheDocument()
		expect(screen.queryByText('Restarting')).not.toBeInTheDocument()
	})

	it('keeps Resuming while the new session has produced nothing', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		renderComposer()
		await vault(userEvent.setup())
		await screen.findByText(RESUMING)
		act(() =>
			sessionsStore.set([
				{ id: 'sess-old', actorId: 'agent-1', status: 'user_stopped' },
				{ id: 'sess-new', actorId: 'agent-1', status: 'starting' },
			]),
		)
		await waitFor(() => expect(logsMock).toHaveBeenCalled())
		expect(screen.getByText(RESUMING)).toBeInTheDocument()
	})

	it('clears when the new session ends without output, so it never sticks', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		renderComposer()
		await vault(userEvent.setup())
		await screen.findByText(RESUMING)
		act(() =>
			sessionsStore.set([
				{ id: 'sess-old', actorId: 'agent-1', status: 'user_stopped' },
				{ id: 'sess-new', actorId: 'agent-1', status: 'failed' },
			]),
		)
		await waitFor(() => expect(screen.queryByText(RESUMING)).not.toBeInTheDocument())
		expect(screen.getByText('Live')).toBeInTheDocument()
	})

	it('does not show Resuming when the marker message fails to send', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		const props = renderComposer({}, vi.fn().mockRejectedValue(new Error('network down')))
		await vault(userEvent.setup())
		await waitFor(() => expect(props.onSend).toHaveBeenCalled())
		expect(await screen.findByText(/Saved, but the message didn't send/)).toBeInTheDocument()
		expect(screen.queryByText(RESUMING)).not.toBeInTheDocument()
	})
})

describe('7c-3: relaunch failed and Retry', () => {
	it('holds the message back, shows the alert line and offers Retry before Undo', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('failed'))
		const props = renderComposer()
		await vault(userEvent.setup())

		const alert = await screen.findByRole('alert')
		expect(alert).toHaveTextContent(FAILED)
		expect(props.onSend).not.toHaveBeenCalled()
		expect(screen.getByText('Live')).toBeInTheDocument()
		const buttons = within(alert.closest('output') as HTMLElement).getAllByRole('button')
		expect(buttons.map((b) => b.textContent)).toEqual(['Retry', 'Undo'])
		// The composer is normal.
		expect(screen.getByRole('textbox')).not.toBeDisabled()
	})

	it('Retry repeats the stop, then sends the held marker and shows Resuming', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('failed'))
		relaunchMock.mockResolvedValue({ relaunch: 'stopped' })
		const props = renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Retry' }))

		await waitFor(() => expect(relaunchMock).toHaveBeenCalledWith('int-1', 'ws-test'))
		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(MARKER))
		expect(props.onSend).toHaveBeenCalledTimes(1)
		expect(await screen.findByText(RESUMING)).toBeInTheDocument()
		expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
	})

	it('Retry that fails again returns to the same line with Retry, no counter, nothing auto-retried', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('failed'))
		relaunchMock.mockResolvedValue({ relaunch: 'failed' })
		const props = renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Retry' }))

		await waitFor(() => expect(relaunchMock).toHaveBeenCalledTimes(1))
		expect(await screen.findByRole('alert')).toHaveTextContent(FAILED)
		expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
		expect(screen.queryByText(/\d+ (attempt|retr)/i)).not.toBeInTheDocument()
		expect(props.onSend).not.toHaveBeenCalled()
		await new Promise((r) => setTimeout(r, 300))
		expect(relaunchMock).toHaveBeenCalledTimes(1)
	})

	it('swaps to the Resuming status row while a Retry is in flight', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('failed'))
		const gate = deferred<{ relaunch: 'stopped' | 'failed' }>()
		relaunchMock.mockReturnValue(gate.promise)
		renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Retry' }))
		expect(await screen.findByText(RESUMING)).toBeInTheDocument()
		expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
		gate.resolve({ relaunch: 'failed' })
		expect(await screen.findByText(FAILED)).toBeInTheDocument()
	})
})

describe('7c-4: undo ends the session', () => {
	it('shows the Undone card with the Ended pill and the session-ended line', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		undoMock.mockResolvedValue({ id: 'int-1', status: 'undone', sessionEnded: true })
		renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Undo' }))

		expect(await screen.findByText('Undone. Cloudflare key is removed.')).toBeInTheDocument()
		expect(
			screen.getByText(
				'This session has ended. Your next message starts a new one without the credential.',
			),
		).toBeInTheDocument()
		expect(screen.getByText('Ended')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
		expect(screen.queryByText(RESUMING)).not.toBeInTheDocument()
	})

	it('does not claim the session ended when it could not be stopped', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		undoMock.mockResolvedValue({ id: 'int-1', status: 'undone', sessionEnded: false })
		renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Undo' }))
		expect(await screen.findByText('Undone. Cloudflare key is removed.')).toBeInTheDocument()
		expect(screen.queryByText(/This session has ended/)).not.toBeInTheDocument()
	})

	it('reads Undoing… and is disabled while the call waits on a relaunch', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		const gate = deferred<unknown>()
		undoMock.mockReturnValue(gate.promise)
		renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await screen.findByText(RESUMING)
		await user.click(screen.getByRole('button', { name: 'Undo' }))
		const busy = await screen.findByRole('button', { name: 'Undoing…' })
		expect(busy).toBeDisabled()
		gate.resolve({ id: 'int-1', status: 'undone', sessionEnded: true })
		expect(await screen.findByText('Undone. Cloudflare key is removed.')).toBeInTheDocument()
	})

	it('keeps the vaulted card and the SPEC error line when undo fails with a 409', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('stopped'))
		undoMock.mockRejectedValue(new Error('409'))
		renderComposer()
		const user = userEvent.setup()
		await vault(user)
		await user.click(await screen.findByRole('button', { name: 'Undo' }))
		expect(
			await screen.findByText(
				"Couldn't undo. The undo window has closed. Revoke it from Settings > Keychain.",
			),
		).toBeInTheDocument()
		expect(screen.getByText(/Vaulted\. Cloudflare key is now available/)).toBeInTheDocument()
	})
})

describe('vaulting another secret while the agent restarts', () => {
	it('disables the vault button and says why, with the SPEC helper line', async () => {
		renderComposer({ secretCapture: null, secretRestarting: true })
		const user = userEvent.setup()
		await user.click(screen.getByRole('textbox'))
		await user.paste(`token ${FAKE_CF}`)
		await user.keyboard('{Enter}')
		expect(await screen.findByText('Maskin detected a secret in your message.')).toBeInTheDocument()
		expect(
			screen.getByText(
				'Messages still send. Vaulting another secret waits until the agent is back.',
			),
		).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Vault \+ assign scope/ })).not.toBeInTheDocument()
	})
})

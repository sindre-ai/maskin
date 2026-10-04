import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const flags = vi.hoisted(() => ({ on: true }))
const chatCaptureMock = vi.hoisted(() => vi.fn())
const undoMock = vi.hoisted(() => vi.fn())
const trackEventMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => (id === 'keychain-chat-capture' ? flags.on : false),
}))
vi.mock('@/components/chat/slash-picker', () => ({ SlashPicker: () => null }))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
	trackChatMentionInserted: () => {},
	trackEvent: trackEventMock,
}))
vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return {
		...actual,
		useActors: () => ({
			data: [
				{ id: 'agent-1', name: 'Infra', type: 'agent' },
				{ id: 'agent-2', name: 'Reviewer', type: 'agent' },
			],
		}),
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
			integrations: { ...actual.api.integrations, chatCapture: chatCaptureMock, undo: undoMock },
		},
	}
})

// Obviously fake, assembled at runtime so no token-shaped literal sits in the repo.
const FAKE_CF = `cfut_${'Zq7'.repeat(14)}`
const FAKE_BLOB = 'x'.repeat(48)

const capture = { sessionId: 'sess-1', agent: { id: 'agent-1', name: 'Infra' } }

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const props = {
		workspaceId: 'ws-test',
		onSend: vi.fn().mockResolvedValue(undefined),
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

async function typeAndSend(text: string) {
	const user = userEvent.setup()
	const box = screen.getByRole('textbox')
	await user.click(box)
	await user.paste(text)
	await user.keyboard('{Enter}')
	return user
}

function storageHolds(needle: string) {
	for (let i = 0; i < sessionStorage.length; i++) {
		const key = sessionStorage.key(i) as string
		if (key.includes(needle) || (sessionStorage.getItem(key) ?? '').includes(needle)) return true
	}
	return false
}

beforeEach(() => {
	flags.on = true
	sessionStorage.clear()
	chatCaptureMock.mockReset()
	undoMock.mockReset()
	trackEventMock.mockReset()
})

describe('Composer secret guard', () => {
	it('blocks a high-confidence secret before any send and shows the card', async () => {
		const props = renderComposer()
		await typeAndSend(`here is my token ${FAKE_CF}`)

		expect(props.onSend).not.toHaveBeenCalled()
		expect(await screen.findByText('Maskin detected a secret in your message.')).toBeInTheDocument()
		expect(screen.getByText(/Looks like a Cloudflare API token/)).toBeInTheDocument()
		// The whole value never renders: only the prefix and last four.
		expect(document.body.textContent).not.toContain(FAKE_CF)
		expect(screen.getByRole('textbox')).toBeDisabled()
		expect(screen.getByRole('textbox')).toHaveValue('')
	})

	it('keeps the token out of sessionStorage, while typing and while the card is open', async () => {
		renderComposer()
		const user = userEvent.setup()
		await user.click(screen.getByRole('textbox'))
		await user.paste(`token ${FAKE_CF}`)
		// Pasted into the box, not sent yet: the draft mirror must not have written it.
		expect(storageHolds(FAKE_CF)).toBe(false)
		await user.keyboard('{Enter}')
		await screen.findByText('Maskin detected a secret in your message.')
		expect(storageHolds(FAKE_CF)).toBe(false)
		expect(storageHolds('Zq7Zq7')).toBe(false)
	})

	it('Esc cancels and drops the message without vaulting or sending', async () => {
		const props = renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await screen.findByText('Maskin detected a secret in your message.')
		await user.keyboard('{Escape}')
		await waitFor(() =>
			expect(
				screen.queryByText('Maskin detected a secret in your message.'),
			).not.toBeInTheDocument(),
		)
		expect(props.onSend).not.toHaveBeenCalled()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(screen.getByRole('textbox')).toHaveValue('')
	})

	it('Enter never vaults, not from the card button and not from the name input', async () => {
		const props = renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await screen.findByText('Maskin detected a secret in your message.')
		await user.keyboard('{Enter}')
		expect(await screen.findByText(/Assign scope for/)).toBeInTheDocument()
		// Focus is now in the credential name input. Only the primary button vaults, so
		// Enter there does nothing (the task body overrides the SPEC line that says otherwise).
		expect(screen.getByLabelText('Credential name')).toHaveFocus()
		await user.keyboard('{Enter}')
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(props.onSend).not.toHaveBeenCalled()
		expect(screen.getByText(/Assign scope for/)).toBeInTheDocument()
		await user.keyboard('{Escape}')
		await waitFor(() => expect(screen.queryByText(/Assign scope for/)).not.toBeInTheDocument())
		expect(chatCaptureMock).not.toHaveBeenCalled()
	})

	it('Cancel message drops it without an event', async () => {
		const props = renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await user.click(await screen.findByRole('button', { name: 'Cancel message' }))
		expect(props.onSend).not.toHaveBeenCalled()
		expect(trackEventMock).not.toHaveBeenCalled()
	})

	it('vaults through the scope step and sends only the redaction marker', async () => {
		chatCaptureMock.mockResolvedValue({
			integrationId: 'int-1',
			undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			undoUrl: '/api/integrations/int-1/undo',
			relaunch: 'stopped',
		})
		const props = renderComposer()
		const user = await typeAndSend(`use ${FAKE_CF} please`)
		await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))

		// 7b: the picker is inline in the chat card, with the session agent pre-selected.
		expect(await screen.findByText(/Assign scope for/)).toBeInTheDocument()
		expect(screen.getByLabelText('Credential name')).toHaveValue('Cloudflare key')
		expect(screen.getByText('Blast radius: 1 agent')).toBeInTheDocument()
		expect(chatCaptureMock).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))

		await waitFor(() => expect(chatCaptureMock).toHaveBeenCalledTimes(1))
		expect(chatCaptureMock).toHaveBeenCalledWith('ws-test', {
			sessionId: 'sess-1',
			providerMode: 'byo_apikey',
			detectedProvider: 'cloudflare',
			displayName: 'Cloudflare key',
			rawSecret: FAKE_CF,
			scopeGrants: [{ kind: 'actor', actorId: 'agent-1' }],
		})
		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
		const sent = (props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
		expect(sent).toBe('use cfut_[REDACTED · vaulted as Cloudflare key] please')
		expect(sent).not.toContain(FAKE_CF)

		expect(
			await screen.findByText(/Vaulted\. Cloudflare key is now available to 1 agent\./),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
		// The composer is usable again and the secret is nowhere in storage.
		expect(screen.getByRole('textbox')).not.toBeDisabled()
		expect(storageHolds(FAKE_CF)).toBe(false)
	})

	it('Save unassigned vaults with an explicit empty grant list', async () => {
		chatCaptureMock.mockResolvedValue({
			integrationId: 'int-2',
			undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			undoUrl: '/api/integrations/int-2/undo',
			relaunch: 'stopped',
		})
		renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))
		await user.click(await screen.findByRole('button', { name: 'Save unassigned' }))
		await waitFor(() =>
			expect(chatCaptureMock).toHaveBeenCalledWith(
				'ws-test',
				expect.objectContaining({ scopeGrants: [] }),
			),
		)
	})

	it('shows a vault failure inside the card and sends nothing', async () => {
		chatCaptureMock.mockRejectedValue(new Error('kms down'))
		const props = renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))
		await user.click(await screen.findByRole('button', { name: /Vault \+ continue chat/ }))
		expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't vault/)
		expect(props.onSend).not.toHaveBeenCalled()
	})

	it('Esc still cancels after a vault fails, because focus comes back into the card', async () => {
		chatCaptureMock.mockRejectedValue(new Error('kms down'))
		const props = renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))
		await user.click(await screen.findByRole('button', { name: /Vault \+ continue chat/ }))
		expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't vault/)
		await waitFor(() => expect(screen.getByLabelText('Credential name')).toHaveFocus())

		await user.keyboard('{Escape}')
		await waitFor(() => expect(screen.queryByText(/Assign scope for/)).not.toBeInTheDocument())
		expect(props.onSend).not.toHaveBeenCalled()
	})

	it('undo calls the endpoint and swaps to the undone card', async () => {
		chatCaptureMock.mockResolvedValue({
			integrationId: 'int-3',
			undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			undoUrl: '/api/integrations/int-3/undo',
			relaunch: 'stopped',
		})
		undoMock.mockResolvedValue({ id: 'int-3', status: 'undone' })
		renderComposer()
		const user = await typeAndSend(FAKE_CF)
		await user.click(await screen.findByRole('button', { name: /Vault \+ assign scope/ }))
		await user.click(await screen.findByRole('button', { name: /Vault \+ continue chat/ }))
		await user.click(await screen.findByRole('button', { name: 'Undo' }))
		expect(undoMock).toHaveBeenCalledWith('int-3', 'ws-test')
		expect(await screen.findByText(/Undone\. Cloudflare key is removed\./)).toBeInTheDocument()
	})

	it('offers Cancel only when the composer has no session to vault into', async () => {
		renderComposer({ secretCapture: null })
		await typeAndSend(FAKE_CF)
		await screen.findByText('Maskin detected a secret in your message.')
		expect(screen.queryByRole('button', { name: /Vault \+ assign scope/ })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel message' })).toBeInTheDocument()
	})

	it('amber match: Send as-is sends the text, reports a false positive and mutes the pattern', async () => {
		const props = renderComposer()
		const user = await typeAndSend(`ray ${FAKE_BLOB}`)
		expect(props.onSend).not.toHaveBeenCalled()
		expect(await screen.findByText('Maybe not a secret — asking to be sure.')).toBeInTheDocument()
		// Amber is not the vault path: no vault button.
		expect(screen.queryByRole('button', { name: /Vault/ })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Send as-is' }))
		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(`ray ${FAKE_BLOB}`))
		expect(trackEventMock).toHaveBeenCalledWith('keychain_secret_false_positive_reported', {
			pattern_id: 'long-blob',
		})

		// Muted for the session: the same shape goes straight through next time.
		await user.click(screen.getByRole('textbox'))
		await user.paste(`again ${FAKE_BLOB}`)
		await user.keyboard('{Enter}')
		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(2))
	})

	it('Edit message restores the text and closes the card', async () => {
		renderComposer()
		const user = await typeAndSend(`ray ${FAKE_BLOB}`)
		await user.click(await screen.findByRole('button', { name: 'Edit message' }))
		expect(screen.getByRole('textbox')).toHaveValue(`ray ${FAKE_BLOB}`)
		expect(screen.queryByText('Maybe not a secret — asking to be sure.')).not.toBeInTheDocument()
	})

	it('sends an ordinary message untouched', async () => {
		const props = renderComposer()
		await typeAndSend('hello there')
		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('hello there'))
	})

	it('does nothing when the flag is off', async () => {
		flags.on = false
		const props = renderComposer()
		await typeAndSend(FAKE_CF)
		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(FAKE_CF))
		expect(screen.queryByText('Maskin detected a secret in your message.')).not.toBeInTheDocument()
	})
})

import { Composer } from '@/components/chat/chat'
import { vaultSeedFrom } from '@/components/chat/vault-prefix-flow'
import { ApiError } from '@/lib/api'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { isClientErrorLoggingPaused } from '@/lib/client-logging-pause'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const chatCaptureMock = vi.hoisted(() => vi.fn())
const undoMock = vi.hoisted(() => vi.fn())
const relaunchMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})
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
			integrations: {
				...actual.api.integrations,
				chatCapture: chatCaptureMock,
				undo: undoMock,
				relaunch: relaunchMock,
			},
		},
	}
})

// Obviously fake, assembled at runtime so no token-shaped literal sits in the repo.
const FAKE_TOKEN = `Zq7${'K3x'.repeat(10)}`

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

const field = () => screen.getByLabelText('Secret to vault') as HTMLInputElement

function storageHolds(needle: string) {
	for (const store of [sessionStorage, localStorage]) {
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i) as string
			if (key.includes(needle) || (store.getItem(key) ?? '').includes(needle)) return true
		}
	}
	return false
}

async function openVaultWith(secret: string) {
	const user = userEvent.setup()
	await user.click(screen.getByRole('textbox'))
	await user.paste(`!${secret}`)
	await screen.findByLabelText('Secret to vault')
	return user
}

const vaulted = (id: string, relaunch: 'stopped' | 'failed' = 'stopped') => ({
	integrationId: id,
	undoExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
	undoUrl: `/api/integrations/${id}/undo`,
	relaunch,
})

beforeEach(() => {
	sessionStorage.clear()
	localStorage.clear()
	chatCaptureMock.mockReset()
	undoMock.mockReset()
	relaunchMock.mockReset()
})

async function vaultAs(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.click(screen.getByRole('button', { name: 'Vault →' }))
	await user.type(await screen.findByLabelText('Credential name'), name)
	await user.type(screen.getByLabelText('Service'), name)
	await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))
}

describe('vaultSeedFrom', () => {
	it.each([
		['!', ''],
		['!abc', 'abc'],
		['!abc\n', 'abc'],
		['!abc  ', 'abc'],
		['!a-b_c.d', 'a-b_c.d'],
	])('%j opens vault mode with %j', (text, seed) => {
		expect(vaultSeedFrom(text)).toBe(seed)
	})

	it.each(['', 'abc', 'a!bc', ' !abc', '\n!abc', '!abc def', '!abc\ndef', '!!abc x y'])(
		'%j is ordinary text',
		(text) => {
			expect(vaultSeedFrom(text)).toBeNull()
		},
	)
})

describe('Composer vault mode (the ! prefix)', () => {
	it('typing ! as the first character opens vault mode: chip, masked field, Vault button, empty composer', async () => {
		const props = renderComposer()
		const user = userEvent.setup()
		await user.click(screen.getByRole('textbox'))
		await user.keyboard('!')

		expect(screen.getByText('! Vault')).toBeInTheDocument()
		expect(field()).toHaveAttribute('type', 'password')
		expect(field()).toHaveAttribute('autocomplete', 'off')
		expect(field()).toHaveAttribute('spellcheck', 'false')
		expect(field()).toHaveFocus()
		expect(screen.getByRole('button', { name: 'Show' })).toHaveAttribute('aria-pressed', 'false')
		expect(screen.getByRole('button', { name: 'Vault →' })).toBeDisabled()
		expect(
			screen.getByText(
				'Nothing after the prefix yet. Paste a secret to vault it, or press Esc to type a normal message.',
			),
		).toBeInTheDocument()
		expect(props.onSend).not.toHaveBeenCalled()
		// The composer textarea never saw the prefix.
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('pasting a ! string with no whitespace opens vault mode with the rest in the field', async () => {
		const props = renderComposer()
		await openVaultWith(FAKE_TOKEN)

		expect(field().value).toBe(FAKE_TOKEN)
		expect(screen.getByRole('button', { name: 'Vault →' })).toBeEnabled()
		expect(
			screen.getByText(/Vault mode\. This goes to your Keychain, not to Infra\. Esc to leave\./),
		).toBeInTheDocument()
		// Masked: the value is not on the page, and it went nowhere.
		expect(document.body.textContent).not.toContain(FAKE_TOKEN)
		expect(props.onSend).not.toHaveBeenCalled()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
	})

	it('Show and Hide toggle the masking, and it re-masks when the field loses focus', async () => {
		renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)

		await user.click(screen.getByRole('button', { name: 'Show' }))
		expect(field()).toHaveAttribute('type', 'text')
		expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true')
		await user.click(screen.getByRole('button', { name: 'Hide' }))
		expect(field()).toHaveAttribute('type', 'password')

		await user.click(screen.getByRole('button', { name: 'Show' }))
		await user.tab()
		expect(field()).toHaveAttribute('type', 'password')
	})

	it.each([['hello !world'], ['a!']])(
		'a ! that is not the first character is plain text: %j',
		async (text) => {
			const props = renderComposer()
			const user = userEvent.setup()
			await user.type(screen.getByRole('textbox'), text)
			expect(screen.getByRole('textbox')).toHaveValue(text)
			expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument()
			await user.keyboard('{Enter}')
			await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(text))
		},
	)

	it('a leading space then ! sends normally', async () => {
		const props = renderComposer()
		const user = userEvent.setup()
		await user.type(screen.getByRole('textbox'), ' !not-a-secret')
		expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument()
		await user.keyboard('{Enter}')
		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('!not-a-secret'))
	})

	it('a pasted string that starts with ! but has whitespace is ordinary text', async () => {
		renderComposer()
		const user = userEvent.setup()
		await user.click(screen.getByRole('textbox'))
		await user.paste('!important notice')
		expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument()
		expect(screen.getByRole('textbox')).toHaveValue('!important notice')
	})

	it('a ! pasted into a composer that already has text is ordinary text', async () => {
		renderComposer()
		const user = userEvent.setup()
		await user.type(screen.getByRole('textbox'), 'see ')
		await user.paste('!abc')
		expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument()
		expect(screen.getByRole('textbox')).toHaveValue('see !abc')
	})

	describe('empty vault mode', () => {
		it('Enter does nothing and never sends the bare prefix', async () => {
			const props = renderComposer()
			const user = userEvent.setup()
			await user.click(screen.getByRole('textbox'))
			await user.keyboard('!')
			await user.keyboard('{Enter}')

			expect(props.onSend).not.toHaveBeenCalled()
			expect(chatCaptureMock).not.toHaveBeenCalled()
			expect(field()).toBeInTheDocument()
			expect(screen.queryByText(/Assign scope for/)).not.toBeInTheDocument()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		})

		it('Backspace in the empty field removes the chip and restores the normal composer', async () => {
			renderComposer()
			const user = userEvent.setup()
			await user.click(screen.getByRole('textbox'))
			await user.keyboard('!')
			await user.keyboard('{Backspace}')

			await waitFor(() =>
				expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument(),
			)
			expect(screen.getByRole('textbox')).toHaveValue('')
			await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
		})

		it('Esc leaves vault mode without sending anything', async () => {
			const props = renderComposer()
			const user = userEvent.setup()
			await user.click(screen.getByRole('textbox'))
			await user.keyboard('!')
			await user.keyboard('{Escape}')

			await waitFor(() =>
				expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument(),
			)
			expect(screen.getByRole('textbox')).toHaveValue('')
			expect(props.onSend).not.toHaveBeenCalled()
		})
	})

	it('Esc with a secret in the field clears it and never turns the draft into a message', async () => {
		const props = renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.keyboard('{Escape}')

		await waitFor(() => expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument())
		expect(screen.getByRole('textbox')).toHaveValue('')
		expect(props.onSend).not.toHaveBeenCalled()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
		// Back in vault mode the field starts empty: nothing was kept.
		await user.click(screen.getByRole('textbox'))
		await user.keyboard('!')
		expect(field().value).toBe('')
	})

	it('Enter in a filled field opens the scope step with Service required, and vaults nothing', async () => {
		const props = renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.keyboard('{Enter}')

		expect(await screen.findByText(/Assign scope for/)).toBeInTheDocument()
		expect(chatCaptureMock).not.toHaveBeenCalled()
		expect(props.onSend).not.toHaveBeenCalled()
		const service = screen.getByLabelText('Service')
		expect(service).toHaveAttribute('placeholder', 'e.g. Linear')
		expect(screen.getByText('Add the service name to continue.')).toBeInTheDocument()

		await user.type(screen.getByLabelText('Credential name'), 'Linear')
		// A name alone is not enough: Service is required in prefix mode.
		expect(screen.getByRole('button', { name: /Vault \+ continue chat/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Save unassigned' })).toBeDisabled()
		await user.type(service, 'Linear')
		expect(screen.getByRole('button', { name: /Vault \+ continue chat/ })).toBeEnabled()
		// Enter in the name input never vaults.
		await user.type(screen.getByLabelText('Credential name'), '{Enter}')
		expect(chatCaptureMock).not.toHaveBeenCalled()
	})

	it('vaults as manual with the raw text only in that call, then sends just the marker', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('int-1'))
		const props = renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.click(screen.getByRole('button', { name: 'Vault →' }))
		await user.type(await screen.findByLabelText('Credential name'), 'Coolify')
		await user.type(screen.getByLabelText('Service'), 'Coolify')
		expect(screen.getByText('KEYCHAIN_BYO_APIKEY_COOLIFY')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))

		await waitFor(() => expect(chatCaptureMock).toHaveBeenCalledTimes(1))
		expect(chatCaptureMock).toHaveBeenCalledWith('ws-test', {
			sessionId: 'sess-1',
			providerMode: 'byo_apikey',
			detectedProvider: 'manual',
			displayName: 'Coolify',
			rawSecret: FAKE_TOKEN,
			agentIds: ['agent-1'],
		})
		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
		const sent = (props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
		expect(sent).toBe('[REDACTED · vaulted as Coolify · env KEYCHAIN_BYO_APIKEY_COOLIFY]')
		expect(sent).not.toContain(FAKE_TOKEN)

		expect(
			await screen.findByText(/Vaulted\. Coolify is now available to 1 agent\./),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
		// The field is gone, the composer is back, and the secret is nowhere.
		expect(screen.queryByLabelText('Secret to vault')).not.toBeInTheDocument()
		expect(screen.getByRole('textbox')).not.toBeDisabled()
		expect(document.body.textContent).not.toContain(FAKE_TOKEN)
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
	})

	it('holds the marker back when the relaunch failed, shows Retry, and sends it once Retry works', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('int-1', 'failed'))
		relaunchMock.mockResolvedValue({ relaunch: 'stopped' })
		const props = renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await vaultAs(user, 'Coolify')

		expect(
			await screen.findByText(
				/Couldn't restart Infra\. The credential is saved, but the session is still running/,
			),
		).toBeInTheDocument()
		expect(props.onSend).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: 'Retry' }))
		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
		expect(relaunchMock).toHaveBeenCalledWith('int-1', 'ws-test')
		expect(await screen.findByText('Resuming with the new credential…')).toBeInTheDocument()
	})

	it('shows the resuming status after a vault, and the Undone card with its session line after Undo', async () => {
		chatCaptureMock.mockResolvedValue(vaulted('int-1'))
		undoMock.mockResolvedValue({ id: 'int-1', status: 'undone', sessionEnded: true })
		renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await vaultAs(user, 'Coolify')

		expect(await screen.findByText('Resuming with the new credential…')).toBeInTheDocument()
		await user.click(await screen.findByRole('button', { name: 'Undo' }))
		expect(await screen.findByText('Undone. Coolify is removed.')).toBeInTheDocument()
		expect(screen.getByText(/This session has ended/)).toBeInTheDocument()
	})

	it('a taken name keeps the card open and the secret in the field; a new name then vaults', async () => {
		chatCaptureMock
			.mockRejectedValueOnce(
				new ApiError(
					409,
					'Another key in this workspace already has this name. Pick a different one.',
				),
			)
			.mockResolvedValueOnce(vaulted('int-2'))
		const props = renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.click(screen.getByRole('button', { name: 'Vault →' }))
		await user.type(await screen.findByLabelText('Credential name'), 'Coolify')
		await user.type(screen.getByLabelText('Service'), 'Coolify')
		await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))

		expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't vault — Another key/)
		expect(props.onSend).not.toHaveBeenCalled()
		expect(screen.getByText(/Assign scope for/)).toBeInTheDocument()

		await user.clear(screen.getByLabelText('Credential name'))
		await user.type(screen.getByLabelText('Credential name'), 'Coolify prod')
		await user.click(screen.getByRole('button', { name: /Vault \+ continue chat/ }))
		await waitFor(() => expect(chatCaptureMock).toHaveBeenCalledTimes(2))
		// The same secret both times: it stayed in the field across the failure.
		expect(chatCaptureMock.mock.calls[1]?.[1]).toMatchObject({
			rawSecret: FAKE_TOKEN,
			displayName: 'Coolify prod',
		})
		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
	})

	it.each([
		['square brackets', 'bad [name]', /square brackets/],
		['an empty slug', '🔑🔑', /at least one letter or number/],
	])('a name with %s is refused in the card before any request', async (_label, name, message) => {
		renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.click(screen.getByRole('button', { name: 'Vault →' }))
		// Pasted, because typing treats square brackets as key names.
		await user.click(await screen.findByLabelText('Credential name'))
		await user.paste(name)
		await user.type(screen.getByLabelText('Service'), 'Linear')
		expect(screen.getByText(message)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Vault \+ continue chat/ })).toBeDisabled()
		expect(chatCaptureMock).not.toHaveBeenCalled()
	})

	it('a secret-shaped name or service is refused in the card', async () => {
		renderComposer()
		const user = await openVaultWith(FAKE_TOKEN)
		await user.click(screen.getByRole('button', { name: 'Vault →' }))
		const shaped = `ghp_${'a'.repeat(36)}`
		await user.type(await screen.findByLabelText('Credential name'), shaped)
		await user.type(screen.getByLabelText('Service'), shaped)
		expect(
			screen.getByText('That name looks like a secret. Use a plain name for the key.'),
		).toBeInTheDocument()
		expect(
			screen.getByText("That looks like a secret. Use the service's plain name."),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Vault \+ continue chat/ })).toBeDisabled()
	})

	it('is disabled with the helper line while the agent is not running, and never vaults', async () => {
		renderComposer({ vaultModeBlocked: true })
		const user = await openVaultWith(FAKE_TOKEN)

		expect(
			screen.getByText('Messages still send. Vaulting another secret waits until Infra is back.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Vault →' })).toBeDisabled()
		await user.keyboard('{Enter}')
		expect(screen.queryByText(/Assign scope for/)).not.toBeInTheDocument()
		expect(chatCaptureMock).not.toHaveBeenCalled()
	})

	it('is disabled in a composer with no session to vault into', async () => {
		const props = renderComposer({ secretCapture: null })
		await openVaultWith(FAKE_TOKEN)

		expect(screen.getByRole('button', { name: 'Vault →' })).toBeDisabled()
		expect(props.onSend).not.toHaveBeenCalled()
	})

	it('writes no draft and pauses client error logging for as long as vault mode is open', async () => {
		renderComposer()
		const user = userEvent.setup()
		await user.click(screen.getByRole('textbox'))
		await user.type(screen.getByRole('textbox'), 'half a thought')
		expect(sessionStorage.getItem('composer-draft:conv-1')).toBe('half a thought')
		await user.clear(screen.getByRole('textbox'))

		expect(isClientErrorLoggingPaused()).toBe(false)
		await user.keyboard('!')
		await screen.findByLabelText('Secret to vault')
		expect(isClientErrorLoggingPaused()).toBe(true)
		await user.paste(FAKE_TOKEN)
		expect(storageHolds(FAKE_TOKEN)).toBe(false)
		expect(sessionStorage.getItem('composer-draft:conv-1')).toBeNull()

		await user.keyboard('{Escape}')
		await waitFor(() => expect(isClientErrorLoggingPaused()).toBe(false))
	})

	it('clears the secret when the composer unmounts', async () => {
		const props = {
			workspaceId: 'ws-test',
			onSend: vi.fn(),
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
			secretCapture: capture,
		}
		const { unmount } = render(<Composer {...props} />, { wrapper: createWorkspaceWrapper() })
		await openVaultWith(FAKE_TOKEN)
		const input = field()
		unmount()
		await waitFor(() => expect(input.value).toBe(''))
		expect(isClientErrorLoggingPaused()).toBe(false)
	})
})

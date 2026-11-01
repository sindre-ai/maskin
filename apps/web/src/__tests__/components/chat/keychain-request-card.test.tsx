import type { IntegrationResponse, MessageKeychainRequest } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockChatCapture = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { integrations: { chatCapture: (...args: unknown[]) => mockChatCapture(...args) } },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const sendMutate = vi.fn()
let participants: Array<{ actorId: string; actorName: string; actorType: string }> = []
let integrations: IntegrationResponse[] = []
vi.mock('@/hooks/use-conversation', () => ({
	useConversation: () => ({ data: { participants } }),
	useSendMessage: () => ({ mutate: sendMutate }),
}))
vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: integrations }),
}))
const continueMutate = vi.fn()
vi.mock('@/hooks/use-sessions', () => ({
	useContinueSession: () => ({ mutate: continueMutate }),
}))

import { KeychainRequestCard, keychainUseHint } from '@/components/chat/keychain-request-card'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const ASKING_AGENT = 'agent-1'
// A quote, a backslash and non-ASCII: all fine in a password.
const PASSWORD = String.raw`pw"with\odd'chars-æøå`

function request(overrides: Partial<MessageKeychainRequest> = {}): MessageKeychainRequest {
	return { session_id: SESSION_ID, kind: 'login', suggested_name: 'e-conomic', ...overrides }
}

function renderCard(req: MessageKeychainRequest = request()) {
	return render(
		<TestWrapper>
			<KeychainRequestCard
				workspaceId="ws-1"
				conversationId="conv-1"
				messageCreatedAt="2026-10-19T10:00:00.000Z"
				askingAgentId={ASKING_AGENT}
				request={req}
			/>
		</TestWrapper>,
	)
}

async function fillLogin(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText('Username or email'), 'me@example.test')
	await user.type(screen.getByLabelText('Password'), PASSWORD)
}

beforeEach(() => {
	vi.clearAllMocks()
	participants = [
		{ actorId: 'human-1', actorName: 'Magnus', actorType: 'human' },
		{ actorId: ASKING_AGENT, actorName: 'Bookkeeper', actorType: 'agent' },
		{ actorId: 'agent-2', actorName: 'Analyst', actorType: 'agent' },
	]
	integrations = []
	mockChatCapture.mockResolvedValue({
		integrationId: 'int-1',
		undoExpiresAt: '2026-10-19T10:05:00.000Z',
		undoUrl: '/api/integrations/int-1/undo',
		relaunch: 'stopped',
	})
	localStorage.clear()
	sessionStorage.clear()
})

describe('KeychainRequestCard', () => {
	it('shows a login form with the suggested name and the hint, and every agent in the chat ticked', () => {
		renderCard(request({ hint: 'To read invoices.' }))

		expect(screen.getByRole('form', { name: 'Add a login to the Keychain' })).toBeInTheDocument()
		expect(screen.getByLabelText('Name')).toHaveValue('e-conomic')
		expect(screen.getByText(/To read invoices\./)).toBeInTheDocument()
		expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
		expect(screen.getByRole('checkbox', { name: 'Bookkeeper' })).toBeChecked()
		expect(screen.getByRole('checkbox', { name: 'Analyst' })).toBeChecked()
		// People in the chat are not agents and are not offered.
		expect(screen.queryByRole('checkbox', { name: 'Magnus' })).not.toBeInTheDocument()
	})

	it('lists a named target that is not in the chat as ticked, and unticks the chat agents that are not named', async () => {
		const user = userEvent.setup()
		renderCard(request({ target_agents: [{ id: 'agent-9', name: 'Infra & DevOps' }] }))

		expect(screen.getByRole('checkbox', { name: 'Infra & DevOps' })).toBeChecked()
		// The asker stays ticked; the other chat agent starts unticked but can be ticked.
		expect(screen.getByRole('checkbox', { name: 'Bookkeeper' })).toBeChecked()
		expect(screen.getByRole('checkbox', { name: 'Analyst' })).not.toBeChecked()
		await user.click(screen.getByRole('checkbox', { name: 'Analyst' }))
		expect(screen.getByRole('checkbox', { name: 'Analyst' })).toBeChecked()

		await user.click(screen.getByRole('checkbox', { name: 'Infra & DevOps' }))
		expect(screen.getByRole('checkbox', { name: 'Infra & DevOps' })).not.toBeChecked()
	})

	it('shares with the named target after Save', async () => {
		const user = userEvent.setup()
		renderCard(request({ target_agents: [{ id: 'agent-9', name: 'Infra & DevOps' }] }))
		await fillLogin(user)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		await waitFor(() => expect(mockChatCapture).toHaveBeenCalledTimes(1))
		expect(mockChatCapture).toHaveBeenCalledWith(
			'ws-1',
			expect.objectContaining({ agentIds: [ASKING_AGENT, 'agent-9'] }),
		)
	})

	it('asks for a single secret, not a username, when an API key was requested', () => {
		renderCard(request({ kind: 'api_key', suggested_name: 'Stripe' }))

		expect(screen.getByRole('form', { name: 'Add an API key to the Keychain' })).toBeInTheDocument()
		expect(screen.getByLabelText('Secret')).toBeInTheDocument()
		expect(screen.queryByLabelText('Username or email')).not.toBeInTheDocument()
	})

	it('cannot save until the name and every value are there', async () => {
		const user = userEvent.setup()
		renderCard(request({ suggested_name: undefined }))
		const save = screen.getByRole('button', { name: 'Save to Keychain' })

		expect(save).toBeDisabled()
		await user.type(screen.getByLabelText('Name'), 'e-conomic')
		await user.type(screen.getByLabelText('Username or email'), 'me@example.test')
		expect(save).toBeDisabled()
		await user.type(screen.getByLabelText('Password'), PASSWORD)
		expect(save).toBeEnabled()
	})

	it('vaults a login for the ticked agents only, straight from the card, marked as from a card', async () => {
		const user = userEvent.setup()
		renderCard()
		await fillLogin(user)
		await user.click(screen.getByRole('checkbox', { name: 'Analyst' }))
		// The value lives in component state only: never in either web storage.
		expect(JSON.stringify({ ...localStorage })).not.toContain(PASSWORD)
		expect(JSON.stringify({ ...sessionStorage })).not.toContain(PASSWORD)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		await waitFor(() => expect(mockChatCapture).toHaveBeenCalledTimes(1))
		expect(mockChatCapture).toHaveBeenCalledWith('ws-1', {
			sessionId: SESSION_ID,
			providerMode: 'byo_login',
			displayName: 'e-conomic',
			username: 'me@example.test',
			password: PASSWORD,
			fromCard: true,
			agentIds: [ASKING_AGENT],
		})
	})

	it('vaults an API key as a manual capture', async () => {
		const user = userEvent.setup()
		renderCard(request({ kind: 'api_key', suggested_name: 'Stripe' }))
		await user.type(screen.getByLabelText('Secret'), 'sk_test_value')

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		await waitFor(() =>
			expect(mockChatCapture).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({
					providerMode: 'byo_apikey',
					detectedProvider: 'manual',
					rawSecret: 'sk_test_value',
					fromCard: true,
				}),
			),
		)
	})

	it('cannot save with no agent ticked: the credential would be readable by nobody', async () => {
		const user = userEvent.setup()
		renderCard()
		await fillLogin(user)
		await user.click(screen.getByRole('checkbox', { name: 'Bookkeeper' }))
		await user.click(screen.getByRole('checkbox', { name: 'Analyst' }))

		expect(screen.getByRole('button', { name: 'Save to Keychain' })).toBeDisabled()
	})

	it('replaces the form with a receipt, clears the value, and posts a message that restarts the agent', async () => {
		const user = userEvent.setup()
		renderCard()
		await fillLogin(user)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		expect(await screen.findByText(/to the Keychain\./)).toBeInTheDocument()
		expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Manage in Keychain' })).toBeInTheDocument()
		expect(sendMutate).toHaveBeenCalledTimes(1)
		const content = (sendMutate.mock.calls[0]?.[0] as { content: string }).content
		expect(content).toContain('e-conomic')
		expect(content).toContain('{{keychain:e-conomic.username}}')
		expect(content).toContain('{{keychain:e-conomic.password}}')
		expect(content).not.toContain('KEYCHAIN_BYO_LOGIN')
		// The message is visible to everyone in the chat and to the agent: no value in it.
		expect(content).not.toContain(PASSWORD)
		expect(content).not.toContain('me@example.test')
	})

	it('for a helper another agent started, the follow-up goes through its own session, with no value in it', async () => {
		const user = userEvent.setup()
		renderCard(request({ reply_to_session: true }))
		await fillLogin(user)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		expect(await screen.findByText(/to the Keychain\./)).toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
		expect(continueMutate).toHaveBeenCalledTimes(1)
		const call = continueMutate.mock.calls[0]?.[0] as { id: string; content: string }
		expect(call.id).toBe(SESSION_ID)
		expect(call.content).toContain('{{keychain:e-conomic.password}}')
		expect(call.content).not.toContain(PASSWORD)
	})

	it('does not restart the agent when its idle session could not be stopped, and says so', async () => {
		mockChatCapture.mockResolvedValue({
			integrationId: 'int-1',
			undoExpiresAt: '2026-10-19T10:05:00.000Z',
			undoUrl: '/api/integrations/int-1/undo',
			relaunch: 'failed',
		})
		const user = userEvent.setup()
		renderCard()
		await fillLogin(user)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		expect(await screen.findByText(/still running without it/)).toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('keeps the form and shows the server message when saving fails', async () => {
		mockChatCapture.mockRejectedValue(
			new ApiError(
				409,
				'Another key in this workspace already has this name. Pick a different one.',
			),
		)
		const user = userEvent.setup()
		renderCard()
		await fillLogin(user)

		await user.click(screen.getByRole('button', { name: 'Save to Keychain' }))

		expect(await screen.findByText(/already has this name/)).toBeInTheDocument()
		expect(screen.getByLabelText('Password')).toHaveValue(PASSWORD)
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('reads "Saved" instead of offering the form again when its credential already exists', () => {
		integrations = [
			{
				id: 'int-1',
				source: 'chat_capture',
				originSessionId: SESSION_ID,
				providerMode: 'byo_login',
				status: 'active',
				displayName: 'e-conomic',
				createdAt: '2026-10-19T10:01:00.000Z',
			} as unknown as IntegrationResponse,
		]

		renderCard()

		expect(screen.getByText('e-conomic')).toBeInTheDocument()
		expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
	})

	it('still offers the form when the saved credential is older than the card or of another kind', () => {
		integrations = [
			{
				id: 'old',
				source: 'chat_capture',
				originSessionId: SESSION_ID,
				providerMode: 'byo_login',
				status: 'active',
				displayName: 'older',
				createdAt: '2026-10-19T09:00:00.000Z',
			},
			{
				id: 'key',
				source: 'chat_capture',
				originSessionId: SESSION_ID,
				providerMode: 'byo_apikey',
				status: 'active',
				displayName: 'a key',
				createdAt: '2026-10-19T10:01:00.000Z',
			},
		] as unknown as IntegrationResponse[]

		renderCard()

		expect(screen.getByLabelText('Password')).toBeInTheDocument()
	})
})

describe('keychainUseHint', () => {
	it('puts an API key in the environment and tells the agent to type a login by reference', () => {
		expect(keychainUseHint('api_key', 'Stripe')).toContain('KEYCHAIN_BYO_APIKEY_STRIPE')
		expect(keychainUseHint('api_key', '🔑')).toBe('')
		const login = keychainUseHint('login', 'e-conomic')
		expect(login).toContain('{{keychain:e-conomic.password}}')
		expect(login).not.toContain('KEYCHAIN_BYO_LOGIN')
	})
})

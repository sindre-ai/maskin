import type { IntegrationResponse, MessageKeychainAccessRequest } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockAllow = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { integrations: { allowFromChat: (...args: unknown[]) => mockAllow(...args) } },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const sendMutate = vi.fn()
let integrations: IntegrationResponse[] = []
vi.mock('@/hooks/use-conversation', () => ({ useSendMessage: () => ({ mutate: sendMutate }) }))
vi.mock('@/hooks/use-integrations', () => ({ useIntegrations: () => ({ data: integrations }) }))

let role = 'member'
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { role }, workspaceId: 'ws-1' }),
}))
let actor: { id: string; type: string } | null = { id: 'human-1', type: 'human' }
vi.mock('@/lib/auth', () => ({ getStoredActor: () => actor }))

import { KeychainAccessRequestCard } from '@/components/chat/keychain-access-request-card'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222'
const AGENT = 'agent-1'

const request: MessageKeychainAccessRequest = {
	session_id: SESSION_ID,
	integration_id: INTEGRATION_ID,
	credential_name: 'Stripe',
	kind: 'api_key',
	hint: 'To read invoices.',
}

function credential(over: Partial<IntegrationResponse> = {}) {
	return buildIntegrationResponse({
		id: INTEGRATION_ID,
		provider: 'custom',
		providerMode: 'byo_apikey',
		displayName: 'Stripe',
		createdBy: 'human-1',
		agentGrants: [],
		...over,
	})
}

function renderCard() {
	return render(
		<TestWrapper>
			<KeychainAccessRequestCard
				workspaceId="ws-1"
				conversationId="conv-1"
				askingAgentId={AGENT}
				request={request}
			/>
		</TestWrapper>,
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	integrations = [credential()]
	role = 'member'
	actor = { id: 'human-1', type: 'human' }
	mockAllow.mockResolvedValue({ actorId: AGENT, relaunch: 'stopped' })
})

describe('KeychainAccessRequestCard', () => {
	it('names the credential and the reason, and offers a duration: this chat, always, or not now', () => {
		renderCard()
		expect(screen.getByRole('heading', { name: 'Let this agent use Stripe?' })).toBeInTheDocument()
		expect(screen.getByText(/To read invoices\./)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Allow in this chat' })).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Always allow' })).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled()
		// Each option says how long it lasts, before anything is clicked.
		expect(screen.getByText(/only this agent, only in this conversation/)).toBeInTheDocument()
		expect(screen.getByText(/until you remove it in Settings/)).toBeInTheDocument()
	})

	it('Always allow: grants for good through the session, then tells the agent where it is', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Always allow' }))

		await waitFor(() =>
			expect(mockAllow).toHaveBeenCalledWith(INTEGRATION_ID, 'ws-1', SESSION_ID, 'always'),
		)
		await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1))
		const { content } = sendMutate.mock.calls[0][0] as { content: string }
		expect(content).toContain('allowed you to use Stripe')
		expect(content).toContain('KEYCHAIN_BYO_APIKEY_STRIPE')
		expect(await screen.findByText(/It stays until you remove it/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument()
	})

	it('Allow in this chat: grants for this conversation only, and says so', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Allow in this chat' }))

		await waitFor(() =>
			expect(mockAllow).toHaveBeenCalledWith(INTEGRATION_ID, 'ws-1', SESSION_ID, 'chat'),
		)
		const { content } = sendMutate.mock.calls[0][0] as { content: string }
		expect(content).toContain('in this chat only')
		expect(await screen.findByText(/in this chat only./)).toBeInTheDocument()
	})

	it('says the agent is still running, and sends no message, when it could not be stopped', async () => {
		mockAllow.mockResolvedValue({ actorId: AGENT, relaunch: 'failed' })
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Always allow' }))
		expect(await screen.findByText(/still running without it/)).toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('shows the server reason and keeps the buttons when allowing fails', async () => {
		mockAllow.mockRejectedValue(new ApiError(403, 'Only the person who saved it can allow it'))
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Always allow' }))
		expect(await screen.findByText(/Couldn't allow: Only the person/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Always allow' })).toBeEnabled()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('declines with a message and never grants', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Not now' }))
		expect(mockAllow).not.toHaveBeenCalled()
		const { content } = sendMutate.mock.calls[0][0] as { content: string }
		expect(content).toContain("don't use Stripe")
		expect(await screen.findByText(/Declined/)).toBeInTheDocument()
	})

	it('reads as allowed after a reload, from the credential grants', () => {
		integrations = [credential({ agentGrants: [{ actorId: AGENT, access: 'read_write' }] })]
		renderCard()
		expect(screen.getByText(/It stays until you remove it/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument()
	})

	it('reads as allowed for this chat only when the grant is for this conversation', () => {
		integrations = [credential({ chatGrants: [{ actorId: AGENT, conversationId: 'conv-1' }] })]
		renderCard()
		expect(screen.getByText(/in this chat only/)).toBeInTheDocument()
	})

	it('still asks in a different chat than the one an Allow was given in', () => {
		integrations = [
			credential({ chatGrants: [{ actorId: AGENT, conversationId: 'another-chat' }] }),
		]
		renderCard()
		expect(screen.getByRole('button', { name: 'Allow in this chat' })).toBeEnabled()
	})

	it('does not read an explicit No access entry as allowed', () => {
		integrations = [credential({ agentGrants: [{ actorId: AGENT, access: 'none' }] })]
		renderCard()
		expect(screen.getByRole('button', { name: 'Always allow' })).toBeEnabled()
	})

	it('reads as gone when the credential was removed', () => {
		integrations = []
		renderCard()
		expect(screen.getByText(/no longer in the Keychain/)).toBeInTheDocument()
	})

	it('only lets the person who saved it, or an admin, allow', () => {
		integrations = [credential({ createdBy: 'someone-else' })]
		const first = renderCard()
		expect(screen.getByRole('button', { name: 'Always allow' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Allow in this chat' })).toBeDisabled()
		expect(
			screen.getByText(/Only the person who saved this or a workspace admin/),
		).toBeInTheDocument()
		first.unmount()

		role = 'admin'
		renderCard()
		expect(screen.getByRole('button', { name: 'Always allow' })).toBeEnabled()
	})
})

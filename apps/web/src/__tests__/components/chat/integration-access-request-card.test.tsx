import type { IntegrationResponse, MessageIntegrationAccessRequest } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockAllow = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { integrations: { allowAccess: (...args: unknown[]) => mockAllow(...args) } },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const sendMutate = vi.fn()
let integrations: IntegrationResponse[] = []
let cardAnswer: 'declined' | 'done' | null = null
vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutate: sendMutate }),
	useCardAnswer: () => cardAnswer,
}))
vi.mock('@/hooks/use-integrations', () => ({ useIntegrations: () => ({ data: integrations }) }))
const continueMutate = vi.fn()
const inputMutate = vi.fn()
vi.mock('@/hooks/use-sessions', () => ({
	useContinueSession: () => ({ mutate: continueMutate }),
	useSendSessionInput: () => ({ mutate: inputMutate }),
}))

let role = 'member'
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { role }, workspaceId: 'ws-1' }),
}))
let actor: { id: string; type: string } | null = { id: 'human-1', type: 'human' }
vi.mock('@/lib/auth', () => ({ getStoredActor: () => actor }))

import { IntegrationAccessRequestCard } from '@/components/chat/integration-access-request-card'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222'
const AGENT = 'agent-1'

const request: MessageIntegrationAccessRequest = {
	session_id: SESSION_ID,
	integration_id: INTEGRATION_ID,
	provider: 'slack',
	display_name: 'Slack',
	level: 'read_write',
	reason: 'To post the summary.',
}

function slack(over: Partial<IntegrationResponse> = {}) {
	return buildIntegrationResponse({
		id: INTEGRATION_ID,
		provider: 'slack',
		status: 'active',
		createdBy: 'human-1',
		defaultAgentAccess: 'none',
		agentGrants: [],
		...over,
	})
}

function renderCard(req: MessageIntegrationAccessRequest = request) {
	return render(
		<TestWrapper>
			<IntegrationAccessRequestCard
				workspaceId="ws-1"
				conversationId="conv-1"
				messageId={7}
				askingAgentId={AGENT}
				request={req}
			/>
		</TestWrapper>,
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	integrations = [slack()]
	cardAnswer = null
	role = 'member'
	actor = { id: 'human-1', type: 'human' }
	mockAllow.mockResolvedValue({ actorId: AGENT, changed: true, relaunch: 'stopped' })
})

describe('IntegrationAccessRequestCard', () => {
	it('names the integration, the level and the reason, with Allow and Not now', () => {
		renderCard()
		expect(
			screen.getByRole('heading', {
				name: 'Let this agent have read and write access to Slack?',
			}),
		).toBeInTheDocument()
		expect(screen.getByText(/To post the summary\./)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled()
	})

	it('Allow: sets the access through the session, then tells the agent', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Allow' }))

		await waitFor(() =>
			expect(mockAllow).toHaveBeenCalledWith(INTEGRATION_ID, 'ws-1', SESSION_ID, 'read_write'),
		)
		await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1))
		const { content, metadata } = sendMutate.mock.calls[0][0] as {
			content: string
			metadata: { hidden_from_chat: boolean }
		}
		expect(content).toContain('allowed you read and write access to Slack')
		expect(metadata.hidden_from_chat).toBe(true)
		expect(await screen.findByText(/It stays until you remove it/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
	})

	it('says the agent is still running, and sends no message, when it could not be stopped', async () => {
		mockAllow.mockResolvedValue({ actorId: AGENT, changed: true, relaunch: 'failed' })
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Allow' }))
		expect(await screen.findByText(/still running with its old access/)).toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('shows the server reason and keeps the buttons when allowing fails', async () => {
		mockAllow.mockRejectedValue(new ApiError(403, 'Only the person who connected it can allow it'))
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Allow' }))
		expect(await screen.findByText(/Couldn't allow: Only the person/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('Not now: tells the agent, records the answer on the card, and never grants', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Not now' }))

		expect(mockAllow).not.toHaveBeenCalled()
		const call = sendMutate.mock.calls[0][0] as {
			content: string
			metadata: { card_answer: unknown }
		}
		expect(call.content).toContain("don't use Slack")
		expect(call.metadata.card_answer).toEqual({ message_id: 7, outcome: 'declined' })
		expect(await screen.findByText(/Declined/)).toBeInTheDocument()
	})

	it('reads as allowed after a reload, from the grant or the default', () => {
		integrations = [slack({ agentGrants: [{ actorId: AGENT, access: 'read_write' }] })]
		const first = renderCard()
		expect(screen.getByText(/It stays until you remove it/)).toBeInTheDocument()
		first.unmount()

		integrations = [slack({ defaultAgentAccess: 'read_write' })]
		renderCard()
		expect(screen.getByText(/It stays until you remove it/)).toBeInTheDocument()
	})

	it('does not read a lower level, or an explicit No access entry, as allowed', () => {
		integrations = [slack({ agentGrants: [{ actorId: AGENT, access: 'read' }] })]
		const first = renderCard()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
		first.unmount()

		// The agent's own entry beats a more open default.
		integrations = [
			slack({
				defaultAgentAccess: 'read_write',
				agentGrants: [{ actorId: AGENT, access: 'none' }],
			}),
		]
		renderCard()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
	})

	it('reads as gone when the integration was disconnected', () => {
		integrations = [slack({ status: 'revoked' })]
		renderCard()
		expect(screen.getByText(/no longer connected/)).toBeInTheDocument()
	})

	it('only lets the person who connected it, or an admin, allow', () => {
		integrations = [slack({ createdBy: 'someone-else' })]
		const first = renderCard()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
		expect(
			screen.getByText(/Only the person who connected this or a workspace admin/),
		).toBeInTheDocument()
		first.unmount()

		role = 'admin'
		renderCard()
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
	})

	it('for a helper: Allow restarts it through its own session, and Not now goes to its input', async () => {
		const helperRequest = { ...request, reply_to_session: true }
		const user = userEvent.setup()
		const first = renderCard(helperRequest)
		await user.click(screen.getByRole('button', { name: 'Allow' }))
		await waitFor(() => expect(continueMutate).toHaveBeenCalledTimes(1))
		expect(sendMutate).not.toHaveBeenCalled()
		expect(continueMutate.mock.calls[0]?.[0]).toMatchObject({ id: SESSION_ID })
		first.unmount()

		renderCard(helperRequest)
		await user.click(screen.getByRole('button', { name: 'Not now' }))
		expect(sendMutate).not.toHaveBeenCalled()
		expect(inputMutate.mock.calls[0]?.[0]).toMatchObject({
			id: SESSION_ID,
			card_answer: { message_id: 7, outcome: 'declined' },
		})
	})

	it('for a helper that was not stopped (it already had the access): writes into it', async () => {
		mockAllow.mockResolvedValue({ actorId: AGENT, changed: false, relaunch: 'stopped' })
		const user = userEvent.setup()
		renderCard({ ...request, reply_to_session: true })
		await user.click(screen.getByRole('button', { name: 'Allow' }))
		await waitFor(() => expect(inputMutate).toHaveBeenCalledTimes(1))
		expect(continueMutate).not.toHaveBeenCalled()
	})
})

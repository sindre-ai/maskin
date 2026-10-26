import type { IntegrationResponse, MessageMcpServerRequest } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockCreate = vi.fn()
const mockAllow = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: {
		customMcpServers: { create: (...args: unknown[]) => mockCreate(...args) },
		integrations: { allowAccess: (...args: unknown[]) => mockAllow(...args) },
	},
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

let actor: { id: string; type: string } | null = { id: 'human-1', type: 'human' }
vi.mock('@/lib/auth', () => ({ getStoredActor: () => actor }))

import { McpServerRequestCard, buildMcpServer } from '@/components/chat/mcp-server-request-card'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const SERVER_ID = '33333333-3333-3333-3333-333333333333'
const AGENT = 'agent-1'

const request: MessageMcpServerRequest = {
	session_id: SESSION_ID,
	name: 'Linear',
	hint: 'To read your issues.',
	command: 'npx',
	args: ['-y', '@linear/mcp-server'],
	env: { REGION: 'eu' },
	secret_env: ['LINEAR_API_KEY'],
}

function renderCard(req: MessageMcpServerRequest = request) {
	return render(
		<TestWrapper>
			<McpServerRequestCard
				workspaceId="ws-1"
				conversationId="conv-1"
				messageId={7}
				messageCreatedAt="2026-10-26T10:00:00.000Z"
				askingAgentId={AGENT}
				request={req}
			/>
		</TestWrapper>,
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	integrations = []
	cardAnswer = null
	actor = { id: 'human-1', type: 'human' }
	mockCreate.mockResolvedValue({ id: SERVER_ID, name: 'Linear', server: {} })
	mockAllow.mockResolvedValue({ actorId: 'agent-1', changed: true, relaunch: 'stopped' })
})

describe('buildMcpServer', () => {
	it('merges the typed secrets into the values the agent gave', () => {
		expect(buildMcpServer(request, { env: { LINEAR_API_KEY: 'lin_123' }, headers: {} })).toEqual({
			command: 'npx',
			args: ['-y', '@linear/mcp-server'],
			env: { REGION: 'eu', LINEAR_API_KEY: 'lin_123' },
		})
	})

	it('builds a remote server with a typed header', () => {
		expect(
			buildMcpServer(
				{ session_id: SESSION_ID, name: 'Linear', url: 'https://mcp.linear.app/mcp' },
				{ env: {}, headers: { Authorization: 'Bearer abc' } },
			),
		).toEqual({ url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer abc' } })
	})
})

describe('McpServerRequestCard', () => {
	it('shows what would run and asks for each secret, with Add disabled until they are typed', async () => {
		const user = userEvent.setup()
		renderCard()
		expect(screen.getByRole('heading', { name: 'Add the Linear tool server?' })).toBeInTheDocument()
		expect(screen.getByText('npx -y @linear/mcp-server')).toBeInTheDocument()
		expect(screen.getByText('REGION=eu')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

		await user.type(screen.getByLabelText('LINEAR_API_KEY'), 'lin_123')
		expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
	})

	it('Add: saves the server with the secret, gives it to the agent, then tells the agent', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.type(screen.getByLabelText('LINEAR_API_KEY'), 'lin_123')
		await user.click(screen.getByRole('button', { name: 'Add' }))

		await waitFor(() =>
			expect(mockCreate).toHaveBeenCalledWith('ws-1', {
				name: 'Linear',
				server: {
					command: 'npx',
					args: ['-y', '@linear/mcp-server'],
					env: { REGION: 'eu', LINEAR_API_KEY: 'lin_123' },
				},
			}),
		)
		expect(mockAllow).toHaveBeenCalledWith(SERVER_ID, 'ws-1', SESSION_ID, 'read_write')
		await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1))
		const { content, metadata } = sendMutate.mock.calls[0][0] as {
			content: string
			metadata: { hidden_from_chat: boolean; card_answer: { message_id: number; outcome: string } }
		}
		// The secret never goes in the message the agent reads.
		expect(content).not.toContain('lin_123')
		expect(content).toContain('added the Linear tool server')
		expect(metadata.hidden_from_chat).toBe(true)
		expect(metadata.card_answer).toEqual({ message_id: 7, outcome: 'done' })
		expect(await screen.findByText(/gave it to this agent/)).toBeInTheDocument()
	})

	it('keeps the form and shows the reason when the name is taken', async () => {
		mockCreate.mockRejectedValue(new ApiError(409, 'A tool server with that name already exists'))
		const user = userEvent.setup()
		renderCard()
		await user.type(screen.getByLabelText('LINEAR_API_KEY'), 'lin_123')
		await user.click(screen.getByRole('button', { name: 'Add' }))

		expect(
			await screen.findByText(/Couldn't add: A tool server with that name/),
		).toBeInTheDocument()
		expect(mockAllow).not.toHaveBeenCalled()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('does not save a second server when only giving access failed and the person retries', async () => {
		mockAllow.mockRejectedValueOnce(new ApiError(500, 'Boom'))
		const user = userEvent.setup()
		renderCard()
		await user.type(screen.getByLabelText('LINEAR_API_KEY'), 'lin_123')
		await user.click(screen.getByRole('button', { name: 'Add' }))
		expect(await screen.findByText(/Couldn't add: Boom/)).toBeInTheDocument()

		// Saved already: only giving access is left, so no secret is asked for again.
		expect(screen.queryByLabelText('LINEAR_API_KEY')).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Give to this agent' }))

		await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1))
		expect(mockCreate).toHaveBeenCalledTimes(1)
		expect(mockAllow).toHaveBeenCalledTimes(2)
	})

	it('says the agent is still running, and sends no message, when it could not be stopped', async () => {
		mockAllow.mockResolvedValue({ actorId: 'agent-1', changed: true, relaunch: 'failed' })
		const user = userEvent.setup()
		renderCard()
		await user.type(screen.getByLabelText('LINEAR_API_KEY'), 'lin_123')
		await user.click(screen.getByRole('button', { name: 'Add' }))
		expect(await screen.findByText(/still running without it/)).toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('Not now: tells the agent and saves nothing', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Not now' }))

		expect(mockCreate).not.toHaveBeenCalled()
		const { metadata } = sendMutate.mock.calls[0][0] as {
			metadata: { card_answer: { message_id: number; outcome: string } }
		}
		expect(metadata.card_answer).toEqual({ message_id: 7, outcome: 'declined' })
		expect(screen.getByText(/Declined/)).toBeInTheDocument()
	})

	it('reads as added, with no form, when the person already added it and gave it to the agent', () => {
		integrations = [
			buildIntegrationResponse({
				id: SERVER_ID,
				provider: 'custom-mcp',
				status: 'active',
				displayName: 'Linear',
				createdAt: '2026-10-26T10:05:00.000Z',
				agentGrants: [{ actorId: AGENT, access: 'read_write' }],
			}),
		]
		renderCard()
		expect(screen.getByText(/gave it to this agent/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
	})

	it('offers only to give the agent a server that was saved but never given (a failed grant, then a reload)', async () => {
		integrations = [
			buildIntegrationResponse({
				id: SERVER_ID,
				provider: 'custom-mcp',
				status: 'active',
				displayName: 'Linear',
				createdAt: '2026-10-26T10:05:00.000Z',
				agentGrants: [],
			}),
		]
		const user = userEvent.setup()
		renderCard()
		expect(screen.queryByText(/gave it to this agent/)).not.toBeInTheDocument()
		expect(screen.queryByLabelText('LINEAR_API_KEY')).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Give to this agent' }))

		await waitFor(() =>
			expect(mockAllow).toHaveBeenCalledWith(SERVER_ID, 'ws-1', SESSION_ID, 'read_write'),
		)
		// The server is already saved: nothing is saved a second time.
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it('shows both the command and the address when a request has both', () => {
		renderCard({ ...request, url: 'https://mcp.linear.app/mcp' })
		expect(screen.getByText('npx -y @linear/mcp-server')).toBeInTheDocument()
		expect(screen.getByText('https://mcp.linear.app/mcp')).toBeInTheDocument()
	})

	it('says the access it gives is read and write', () => {
		renderCard()
		expect(screen.getByText(/with read and write access/)).toBeInTheDocument()
	})

	it('cannot be added by an agent', () => {
		actor = { id: 'agent-1', type: 'agent' }
		renderCard({ ...request, secret_env: undefined })
		expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
		expect(screen.getByText('Only a person can add a tool server.')).toBeInTheDocument()
	})
})

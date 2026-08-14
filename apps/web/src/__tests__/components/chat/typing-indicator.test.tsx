import { TypingIndicator } from '@/components/chat/typing-indicator'
import type { SessionLogResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			get: vi.fn(),
			logs: vi.fn(),
		},
		actors: { get: vi.fn() },
	},
}))

import { api } from '@/lib/api'

const streamJsonLine = (payload: Record<string, unknown>) => JSON.stringify(payload)

function toolUseLog(id: number, name: string): SessionLogResponse {
	return {
		id,
		sessionId: 'session-1',
		stream: 'stdout',
		content: streamJsonLine({
			type: 'assistant',
			message: {
				content: [{ type: 'tool_use', id: `tool-${id}`, name, input: {} }],
			},
		}),
		createdAt: '2026-08-14T00:00:00Z',
	}
}

function resultLog(id: number): SessionLogResponse {
	return {
		id,
		sessionId: 'session-1',
		stream: 'stdout',
		content: streamJsonLine({
			type: 'result',
			subtype: 'success',
			duration_ms: 1000,
			num_turns: 1,
			total_cost_usd: 0.01,
			is_error: false,
		}),
		createdAt: '2026-08-14T00:00:00Z',
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('TypingIndicator', () => {
	it('renders agent name and the current verb while the session is running', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue(
			buildSessionResponse({
				id: 'session-1',
				actorId: 'actor-42',
				status: 'running',
				startedAt: new Date().toISOString(),
			}),
		)
		vi.mocked(api.actors.get).mockResolvedValue(
			buildActorResponse({ id: 'actor-42', name: 'Chief of Staff', type: 'agent' }),
		)
		vi.mocked(api.sessions.logs).mockResolvedValue([toolUseLog(1, 'list_objects')])

		render(<TypingIndicator sessionId="session-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		await waitFor(() => {
			expect(screen.getByText('Chief of Staff')).toBeInTheDocument()
		})
		expect(screen.getByRole('status', { hidden: true })).toBeInTheDocument()
		expect(screen.getByText(/Using list_objects/)).toBeInTheDocument()
	})

	it('renders elapsed time from session.startedAt', async () => {
		const startedAt = new Date(Date.now() - 3 * 60_000).toISOString() // 3m ago
		vi.mocked(api.sessions.get).mockResolvedValue(
			buildSessionResponse({
				id: 'session-1',
				actorId: 'actor-42',
				status: 'running',
				startedAt,
			}),
		)
		vi.mocked(api.actors.get).mockResolvedValue(
			buildActorResponse({ id: 'actor-42', name: 'Chief of Staff', type: 'agent' }),
		)
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		render(<TypingIndicator sessionId="session-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		await waitFor(() => {
			// formatDurationMs renders minutes as "3m"
			expect(screen.getByText(/3m/)).toBeInTheDocument()
		})
	})

	it('renders nothing once the session has idled awaiting input (last log is a result)', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue(
			buildSessionResponse({ id: 'session-1', actorId: 'actor-42', status: 'running' }),
		)
		vi.mocked(api.actors.get).mockResolvedValue(
			buildActorResponse({ id: 'actor-42', name: 'Chief of Staff', type: 'agent' }),
		)
		vi.mocked(api.sessions.logs).mockResolvedValue([toolUseLog(1, 'noop'), resultLog(2)])

		render(<TypingIndicator sessionId="session-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		// After the queries resolve the indicator should collapse.
		await waitFor(() => {
			expect(vi.mocked(api.sessions.logs)).toHaveBeenCalled()
		})
		await waitFor(() => {
			expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument()
		})
	})

	it('renders nothing when the session is not running', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue(
			buildSessionResponse({ id: 'session-1', status: 'completed', actorId: 'actor-42' }),
		)
		vi.mocked(api.actors.get).mockResolvedValue(buildActorResponse({ id: 'actor-42' }))
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		render(<TypingIndicator sessionId="session-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		await waitFor(() => {
			expect(vi.mocked(api.sessions.get)).toHaveBeenCalled()
		})
		expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument()
	})
})

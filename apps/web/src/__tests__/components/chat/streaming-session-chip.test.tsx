import { StreamingSessionChip } from '@/components/chat/streaming-session-chip'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			get: vi.fn(),
			logs: vi.fn(),
			stop: vi.fn(),
		},
		actors: { get: vi.fn() },
	},
}))

import { api } from '@/lib/api'

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.sessions.logs).mockResolvedValue([])
})

describe('StreamingSessionChip', () => {
	it('renders a Stop button with a ≥44px tap target while the session is running', async () => {
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

		render(<StreamingSessionChip sessionId="session-1" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		const stopButton = await screen.findByRole('button', { name: /Stop streaming/i })
		expect(stopButton).toBeVisible()
		// The button has an after:pseudo enlarging the hit target to 44x44 —
		// assert the class hook so a future rewrite can't silently shrink it.
		expect(stopButton.className).toContain('after:min-h-11')
		expect(stopButton.className).toContain('after:min-w-11')
	})

	it('halts the stream when Stop is tapped and flips to a muted "Stopped" state', async () => {
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
		vi.mocked(api.sessions.stop).mockResolvedValue(
			buildSessionResponse({ id: 'session-1', status: 'completed' }),
		)
		const onStopped = vi.fn()

		render(
			<StreamingSessionChip sessionId="session-1" workspaceId="ws-1" onStopped={onStopped} />,
			{ wrapper: TestWrapper },
		)

		const stopButton = await screen.findByRole('button', { name: /Stop streaming/i })
		fireEvent.click(stopButton)

		await waitFor(() => {
			expect(vi.mocked(api.sessions.stop)).toHaveBeenCalledWith('session-1', 'ws-1')
		})
		await waitFor(() => {
			expect(screen.getByText('Stopped')).toBeInTheDocument()
		})
		// Optimistically flips before the mutation resolves — the chip must no
		// longer offer a way to stop the same session again.
		expect(screen.queryByRole('button', { name: /Stop streaming/i })).not.toBeInTheDocument()
		await waitFor(() => expect(onStopped).toHaveBeenCalledTimes(1))
	})

	it('renders as Stopped when the underlying session has already finished', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue(
			buildSessionResponse({
				id: 'session-1',
				actorId: 'actor-42',
				status: 'completed',
			}),
		)
		vi.mocked(api.actors.get).mockResolvedValue(
			buildActorResponse({ id: 'actor-42', name: 'Chief of Staff', type: 'agent' }),
		)

		render(<StreamingSessionChip sessionId="session-1" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() => {
			expect(screen.getByText('Stopped')).toBeInTheDocument()
		})
		expect(screen.queryByRole('button', { name: /Stop streaming/i })).not.toBeInTheDocument()
	})

	it('reverts the optimistic Stopped state if the mutation fails', async () => {
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
		vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('boom'))

		render(<StreamingSessionChip sessionId="session-1" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		const stopButton = await screen.findByRole('button', { name: /Stop streaming/i })
		fireEvent.click(stopButton)

		await waitFor(() => {
			// The optimistic Stopped chip should disappear and the Stop button
			// should return so the user can retry.
			expect(screen.queryByText('Stopped')).not.toBeInTheDocument()
		})
		expect(screen.getByRole('button', { name: /Stop streaming/i })).toBeVisible()
	})
})

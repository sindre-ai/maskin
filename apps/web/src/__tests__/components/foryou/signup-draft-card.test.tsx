import { SignupDraftCard, computeMinutesSinceSignup } from '@/components/foryou/signup-draft-card'
import type { ObjectResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const trackVisibleMock = vi.fn()
const navigateMock = vi.fn()
const updateObjectMutate = vi.fn()

vi.mock('@/lib/analytics', () => ({
	trackQualifiedBetVisible: (p: {
		entity_id: string
		entity_type: 'bet'
		minutes_since_signup: number
	}) => trackVisibleMock(p),
}))

vi.mock('@/hooks/use-objects', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-objects')>('@/hooks/use-objects')
	return {
		...actual,
		useUpdateObject: () => ({
			mutate: (args: unknown) => updateObjectMutate(args),
			isPending: false,
		}),
	}
})

vi.mock('@tanstack/react-router', async () => {
	const actual =
		await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
	return {
		...actual,
		useNavigate: () => (args: unknown) => navigateMock(args),
	}
})

function buildBet(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return {
		id: 'bet-1',
		workspaceId: 'ws-1',
		type: 'bet',
		title: 'Ship first bet from signup research',
		content: null,
		status: 'qualified',
		metadata: { source: 'signup_first_bet_draft' },
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: '2026-08-14T00:00:00Z',
		updatedAt: null,
		...overrides,
	}
}

describe('computeMinutesSinceSignup', () => {
	it('returns floored minutes since the workspace was created', () => {
		const created = '2026-08-14T00:00:00Z'
		const now = new Date('2026-08-14T00:12:30Z').getTime()
		expect(computeMinutesSinceSignup(created, now)).toBe(12)
	})
	it('returns 0 when the timestamp is missing', () => {
		expect(computeMinutesSinceSignup(null)).toBe(0)
	})
	it('returns 0 for clock skew (created in the future)', () => {
		const created = '2026-08-14T00:10:00Z'
		const now = new Date('2026-08-14T00:00:00Z').getTime()
		expect(computeMinutesSinceSignup(created, now)).toBe(0)
	})
})

describe('SignupDraftCard', () => {
	beforeEach(() => {
		trackVisibleMock.mockReset()
		navigateMock.mockReset()
		updateObjectMutate.mockReset()
	})

	it('fires qualified_bet_visible once on mount with bet id and minutes_since_signup', () => {
		const bet = buildBet()
		const { rerender } = render(
			<SignupDraftCard workspaceId="ws-1" bet={bet} workspaceCreatedAt="2026-08-13T00:00:00Z" />,
			{ wrapper: createWorkspaceWrapper() },
		)

		expect(trackVisibleMock).toHaveBeenCalledTimes(1)
		const call = trackVisibleMock.mock.calls[0]?.[0] as {
			entity_id: string
			entity_type: string
			minutes_since_signup: number
		}
		expect(call.entity_id).toBe('bet-1')
		expect(call.entity_type).toBe('bet')
		expect(call.minutes_since_signup).toBeGreaterThan(0)

		// Re-render with same bet must not re-fire.
		rerender(
			<SignupDraftCard workspaceId="ws-1" bet={bet} workspaceCreatedAt="2026-08-13T00:00:00Z" />,
		)
		expect(trackVisibleMock).toHaveBeenCalledTimes(1)
	})

	it('accept keeps status qualified and stamps metadata.accepted_from_signup=true', async () => {
		const user = userEvent.setup()
		const bet = buildBet()
		render(<SignupDraftCard workspaceId="ws-1" bet={bet} workspaceCreatedAt={null} />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Accept' }))

		expect(updateObjectMutate).toHaveBeenCalledWith({
			id: 'bet-1',
			data: {
				metadata: { source: 'signup_first_bet_draft', accepted_from_signup: true },
			},
		})
	})

	it('dismiss transitions to failed with metadata.dismissal_reason', async () => {
		const user = userEvent.setup()
		const bet = buildBet()
		render(<SignupDraftCard workspaceId="ws-1" bet={bet} workspaceCreatedAt={null} />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Dismiss' }))

		expect(updateObjectMutate).toHaveBeenCalledWith({
			id: 'bet-1',
			data: {
				status: 'failed',
				metadata: {
					source: 'signup_first_bet_draft',
					dismissal_reason: 'signup_auto_draft_rejected',
				},
			},
		})
	})

	it('edit navigates to the bet detail route', async () => {
		const user = userEvent.setup()
		const bet = buildBet()
		render(<SignupDraftCard workspaceId="ws-1" bet={bet} workspaceCreatedAt={null} />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Edit' }))

		await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 'bet-1' },
		})
	})
})

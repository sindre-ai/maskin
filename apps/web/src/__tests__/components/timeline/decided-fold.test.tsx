import {
	DecidedFold,
	findDecisionAnswer,
	isDecidedFoldEligible,
} from '@/components/timeline/decided-fold'
import type { EventResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildEventResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'actor-1', name: 'Ada', type: 'human' }] }),
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useMentionSessionsForObject: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: () => {}, isPending: false }),
	useUpdateComment: () => ({ mutate: () => {}, isPending: false }),
	useDeleteComment: () => ({ mutate: () => {}, isPending: false }),
}))

function decisionEvent(overrides: Partial<EventResponse> = {}): EventResponse {
	return buildEventResponse({
		id: overrides.id ?? 42,
		action: 'commented',
		entityType: 'bet',
		entityId: 'obj-1',
		actorId: 'actor-1',
		createdAt: '2026-01-01T12:00:00Z',
		...overrides,
		data: {
			...(overrides.data ?? {}),
			content: 'Please pick one',
			decision: {
				title: 'Ship the onboarding cut?',
				summary: '3 of 5 signups stall on step 2. I have drafted the copy already.',
				ask: 'This changes what every new customer sees first, so I will not ship it alone.',
				options: [
					{
						label: '7-day window',
						consequences: ['Ships with cycle 1', 'Adds 18 tickets'],
						recommended: true,
					},
					{
						label: 'Hold',
						consequences: ['Nothing ships this cycle', 'Keeps losing activations'],
					},
				],
			},
		},
	})
}

function replyEvent(content: string, createdAt: string, id = 100): EventResponse {
	return buildEventResponse({
		id,
		action: 'commented',
		entityType: 'bet',
		entityId: 'obj-1',
		createdAt,
		data: { content, parentEventId: 42 },
	})
}

describe('findDecisionAnswer', () => {
	it('returns the reply whose text names an option label', () => {
		const event = decisionEvent()
		const answer = replyEvent('7-day window', '2026-01-01T13:00:00Z')
		expect(findDecisionAnswer(event, [answer])).toBe(answer)
	})

	it('returns null when no reply matches an option label', () => {
		const event = decisionEvent()
		const chatter = replyEvent('interesting', '2026-01-01T13:00:00Z')
		expect(findDecisionAnswer(event, [chatter])).toBeNull()
	})

	it('returns null on a comment that carries no decision', () => {
		const plain = buildEventResponse({ id: 7, action: 'commented' })
		expect(findDecisionAnswer(plain, [])).toBeNull()
	})
})

describe('isDecidedFoldEligible', () => {
	const now = Date.parse('2026-01-02T00:00:00Z')

	it('is true when the answer is at least 1 hour old', () => {
		const event = decisionEvent()
		const answer = replyEvent('Hold', '2026-01-01T22:00:00Z') // 2h ago
		expect(isDecidedFoldEligible(event, [answer], now)).toBe(true)
	})

	it('is false when the answer landed less than 1 hour ago', () => {
		const event = decisionEvent()
		const answer = replyEvent('Hold', '2026-01-01T23:30:00Z') // 30m ago
		expect(isDecidedFoldEligible(event, [answer], now)).toBe(false)
	})

	it('is false for unresolved decisions', () => {
		const event = decisionEvent()
		expect(isDecidedFoldEligible(event, [], now)).toBe(false)
	})
})

describe('DecidedFold row', () => {
	beforeEach(() => {
		window.localStorage.clear()
	})

	it('renders the DECIDED eyebrow, title, and summary first clause folded by default', () => {
		const event = decisionEvent()
		const answer = replyEvent('Hold', '2026-01-01T13:00:00Z')

		render(
			<DecidedFold
				event={event}
				replies={[answer]}
				answer={answer}
				workspaceId="ws-1"
				objectId="obj-1"
				isUnread={false}
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)

		expect(screen.getByText('DECIDED')).toBeInTheDocument()
		expect(screen.getByText('Ship the onboarding cut?')).toBeInTheDocument()
		expect(screen.getByText(/3 of 5 signups stall on step 2\./)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Expand decided/ })).toHaveAttribute(
			'aria-expanded',
			'false',
		)
	})

	it('expands to the full comment on click and persists the choice in localStorage', async () => {
		const user = userEvent.setup()
		const event = decisionEvent({ id: 999 })
		const answer = replyEvent('Hold', '2026-01-01T13:00:00Z', 1000)

		render(
			<DecidedFold
				event={event}
				replies={[answer]}
				answer={answer}
				workspaceId="ws-1"
				objectId="obj-1"
				isUnread={false}
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /Expand decided/ }))

		expect(screen.queryByText('DECIDED')).toBeNull()
		expect(window.localStorage.getItem('timeline-decided-fold:999')).toBe('open')

		// Clicking the fold caret re-folds and drops the key from localStorage.
		await user.click(screen.getByRole('button', { name: /Fold/ }))
		expect(screen.getByText('DECIDED')).toBeInTheDocument()
		expect(window.localStorage.getItem('timeline-decided-fold:999')).toBeNull()
	})

	it('seeds folded state per-decision from localStorage', () => {
		const event = decisionEvent({ id: 555 })
		const answer = replyEvent('Hold', '2026-01-01T13:00:00Z', 556)
		window.localStorage.setItem('timeline-decided-fold:555', 'open')

		render(
			<DecidedFold
				event={event}
				replies={[answer]}
				answer={answer}
				workspaceId="ws-1"
				objectId="obj-1"
				isUnread={false}
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)

		// Row rendered unfolded; DECIDED eyebrow (fold-only) is absent.
		expect(screen.queryByText('DECIDED')).toBeNull()
		expect(screen.getByRole('button', { name: /Fold/ })).toBeInTheDocument()
	})
})

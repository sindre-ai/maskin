import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'

/**
 * Dismissing a card that already carries a decision receipt clears it out of
 * `decided`, and the server has already dropped it from the unread list — so a
 * mark-read that then fails leaves the card in neither place. Without a
 * rollback it disappears for good while the toast promises the opposite.
 */
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

type TestState = {
	__items: UnreadItem[]
	__markReadFails: boolean
	__lastMutateOptions?: unknown
	__createCalls: Array<Record<string, unknown>>
	__markReadCalls: Array<Record<string, unknown>>
}
const testState = globalThis as unknown as TestState
testState.__items = []
testState.__markReadFails = false
testState.__createCalls = []
testState.__markReadCalls = []

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: () => ({
		data: { items: (globalThis as unknown as TestState).__items },
		isLoading: false,
	}),
	useMarkRead: () => ({
		// `mutateAsync` returns a promise per call, so each caller keeps its own
		// success/failure handling. This is the API the route must use.
		mutateAsync: (vars: Record<string, unknown>) => {
			const state = globalThis as unknown as TestState
			state.__markReadCalls.push(vars)
			if (!state.__markReadFails) return Promise.resolve({})
			return Promise.reject(new Error('mark-read failed'))
		},
		// `mutate` is modelled the way react-query really behaves, so a
		// regression back to it is caught rather than passing against a kinder
		// stub. The hook holds ONE mutation observer; every `observer.mutate()`
		// overwrites the previous call's options and detaches its observer, so
		// across a bulk loop only the LAST call's `onError` can ever fire.
		mutate: (_vars: unknown, opts?: { onError?: () => void }) => {
			const state = globalThis as unknown as TestState
			state.__lastMutateOptions = opts
			queueMicrotask(() => {
				if (!state.__markReadFails) return
				if (state.__lastMutateOptions !== opts) return // observer was stolen by a later call
				opts?.onError?.()
			})
		},
	}),
	useMarkUnread: () => ({ mutateAsync: () => Promise.resolve({}), mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: undefined, isFetched: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => {
	class ApiError extends Error {}
	return {
		ApiError,
		api: {
			events: {
				create: async (_ws: string, input: Record<string, unknown>) => {
					;(globalThis as unknown as TestState).__createCalls.push(input)
					return { id: 'evt-1' }
				},
			},
		},
	}
})

// The stub exposes the two callbacks this test drives and reports whether the
// route is still handing it a decision receipt.
vi.mock('@/components/foryou/feed-card', () => ({
	FeedCard: ({
		item,
		decided,
		onDecide,
		onMarkRead,
		onReplied,
	}: {
		item: { object?: { title?: string | null } }
		decided: { id: string; label: string } | null
		onDecide: (option: { id: string; label: string }) => void
		onMarkRead: () => void
		onReplied: () => void
	}) => (
		<div data-testid="foryou-feed-card" data-decided={String(Boolean(decided))}>
			{item.object?.title}
			<button type="button" onClick={() => onDecide({ id: 'approve', label: 'Approve' })}>
				decide
			</button>
			<button type="button" onClick={onMarkRead}>
				dismiss
			</button>
			<button type="button" onClick={onReplied}>
				reply
			</button>
		</div>
	),
}))
vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/foryou/onboarding-prompt-card', () => ({ OnboardingPromptCard: () => null }))
vi.mock('@/components/foryou/brief-card', () => ({ BriefCard: () => null }))
vi.mock('@/components/foryou/release-card', () => ({ ReleaseCard: () => null }))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const ForYouPage = (Route as unknown as { component: React.FC }).component

function buildItem(id: string, title: string): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: 1,
		mentioning_unread_count: 0,
		max_unread_attention: null,
		latest_event_id: 42,
		latest_activity_at: '2026-08-11T10:00:00.000Z',
		latest_mention: {
			event_id: 4242,
			actor_id: 'agent-1',
			created_at: '2026-08-11T10:00:00.000Z',
			content: 'Which way do we go?',
			attention: null,
			decision: null,
		},
		object: {
			id,
			workspaceId: 'ws-1',
			type: 'insight',
			title,
			content: null,
			status: 'active',
			metadata: null,
			driver: null,
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
	}
}

async function renderFeed() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	const view = render(
		<QueryClientProvider client={client}>
			<ForYouPage />
		</QueryClientProvider>,
	)
	await act(async () => {
		await Promise.resolve()
	})
	return view
}

describe('For You — dismiss rollback', () => {
	beforeEach(() => {
		testState.__items = [buildItem('thread-1', 'Renewal terms need a read')]
		testState.__markReadFails = false
		testState.__createCalls = []
		testState.__markReadCalls = []
	})

	it('keeps the decision receipt when dismissing it fails', async () => {
		const user = userEvent.setup()
		await renderFeed()

		// Take an option — the card flips to its receipt.
		await user.click(screen.getByRole('button', { name: 'decide' }))
		await act(async () => {
			await Promise.resolve()
		})
		expect(screen.getByTestId('foryou-feed-card')).toHaveAttribute('data-decided', 'true')

		// Now dismiss it and let the mark-read fail.
		testState.__markReadFails = true
		await user.click(screen.getByRole('button', { name: 'dismiss' }))
		await act(async () => {
			await Promise.resolve()
		})

		const card = screen.getByTestId('foryou-feed-card')
		expect(card).toBeInTheDocument()
		expect(card).toHaveAttribute('data-decided', 'true')
	})

	// The answer belongs under the question. Posted loose on the object, the
	// agent that asked has to infer from timing which of its asks was answered.
	it('threads the taken option under the comment that raised the card', async () => {
		const view = await renderFeed()
		await act(async () => {
			view.getByText('decide').click()
		})
		expect(testState.__createCalls).toHaveLength(1)
		expect(testState.__createCalls[0]).toMatchObject({
			entity_id: 'thread-1',
			content: 'Approve',
			parent_event_id: 4242,
		})
	})

	// A typed answer settles the thread just as taking an option does. It used
	// to leave the card sitting in the feed, so the reader saw their own answer
	// still asking to be answered.
	it('marks the thread read when the reader types an answer', async () => {
		const view = await renderFeed()
		await act(async () => {
			view.getByText('reply').click()
		})
		expect(testState.__markReadCalls).toMatchObject([
			{ entityType: 'object', entityId: 'thread-1', lastEventId: 42 },
		])
	})

	it('still hides the card when the dismissal succeeds', async () => {
		const user = userEvent.setup()
		await renderFeed()

		await user.click(screen.getByRole('button', { name: 'decide' }))
		await act(async () => {
			await Promise.resolve()
		})
		await user.click(screen.getByRole('button', { name: 'dismiss' }))
		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.queryByTestId('foryou-feed-card')).not.toBeInTheDocument()
	})

	// The regression this file is really about. "Dismiss all" marks every card
	// read through one shared mutation observer, so a rollback hung off
	// per-call `mutate` callbacks would fire for the LAST card only and leave
	// every other one hidden for good — the column emptied against a backend
	// that rejected the whole batch. Seeding a single item, as the two tests
	// above do, passes either way.
	it('puts every card back when a bulk dismissal fails', async () => {
		testState.__items = [
			buildItem('thread-1', 'Renewal terms need a read'),
			buildItem('thread-2', 'Trigger settings rewrite'),
			buildItem('thread-3', 'Pricing page copy'),
		]
		await renderFeed()
		expect(screen.getAllByTestId('foryou-feed-card')).toHaveLength(3)

		testState.__markReadFails = true
		// Alt+U is the keyboard mirror of the `···` menu's "Dismiss all".
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', altKey: true }))
		})
		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.getAllByTestId('foryou-feed-card')).toHaveLength(3)
	})
})

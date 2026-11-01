import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LatestMentionDecisionDraft, UnreadItem } from '@/lib/api'

/**
 * Every write on a For You card must happen once. The handlers can be reached
 * twice before a render lands (the `···` menu fires onSelect twice for one
 * click), and a stacked card can be settled both message by message and from
 * the card's own bar.
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
	__createCalls: Array<Record<string, unknown>>
}
const testState = globalThis as unknown as TestState
testState.__items = []
testState.__createCalls = []

vi.mock('@/hooks/use-for-you', () => ({
	useForYou: () => ({
		data: { items: (globalThis as unknown as TestState).__items },
		isLoading: false,
	}),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => ({ mutateAsync: () => Promise.resolve({}), mutate: vi.fn() }),
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
			objects: { approve: () => Promise.resolve({}) },
		},
	}
})

// The stub exposes what the route hands a card: the bar's option, and each
// stacked message's Send.
vi.mock('@/components/foryou/feed-card', () => ({
	FeedCard: ({
		item,
		decided,
		onDecide,
		onDraftAction,
	}: {
		item: UnreadItem
		decided: { id: string; label: string } | null
		onDecide: (option: { id: string; label: string }) => void
		onDraftAction: (draft: LatestMentionDecisionDraft, action: 'send' | 'skip') => Promise<unknown>
	}) => {
		const decision = item.latest_mention?.decision
		const recommended = decision?.options.find((option) => option.recommended)
		return (
			<div data-testid="foryou-feed-card" data-decided={String(Boolean(decided))}>
				<span>{item.object?.title}</span>
				{recommended ? (
					<button type="button" onClick={() => onDecide({ id: 'bar', label: recommended.label })}>
						{`bar ${item.object?.title}`}
					</button>
				) : null}
				{decision?.drafts?.map((draft) => (
					<button
						key={draft.id}
						type="button"
						onClick={() => void onDraftAction(draft, 'send').catch(() => {})}
					>
						{`send ${draft.id}`}
					</button>
				))}
			</div>
		)
	},
}))
vi.mock('@/components/foryou/foryou-header', () => ({
	ForYouHeader: ({
		bulkActions,
	}: {
		bulkActions: Array<{ id: string; label: string; count?: number; onSelect: () => void }>
	}) => (
		<div>
			{bulkActions.map((action) => (
				<button key={action.id} type="button" onClick={action.onSelect}>
					{`${action.label} (${action.count})`}
				</button>
			))}
		</div>
	),
}))
vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/foryou/onboarding-prompt-card', () => ({ OnboardingPromptCard: () => null }))
vi.mock('@/components/foryou/briefing-row', () => ({ BriefingRow: () => null }))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const ForYouPage = (Route as unknown as { component: React.FC }).component

function buildItem(
	id: string,
	title: string,
	option: { label: string; destructive?: boolean },
	drafts?: LatestMentionDecisionDraft[],
): UnreadItem {
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
			decision: {
				title,
				summary: 'Summary',
				ask: 'Ask',
				options: [{ label: option.label, consequences: [], recommended: true, ...option }],
				...(drafts ? { drafts } : {}),
			},
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

async function flush() {
	await act(async () => {
		await Promise.resolve()
		await Promise.resolve()
	})
}

async function renderFeed() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
	render(
		<QueryClientProvider client={client}>
			<ForYouPage />
		</QueryClientProvider>,
	)
	await flush()
}

const contents = () => testState.__createCalls.map((call) => call.content)

describe('For You — one write per action', () => {
	beforeEach(() => {
		testState.__items = []
		testState.__createCalls = []
	})

	it('posts one reply when an option is taken twice before a render', async () => {
		testState.__items = [buildItem('a', 'Pick a window', { label: '7-day window' })]
		await renderFeed()
		const bar = screen.getByRole('button', { name: 'bar Pick a window' })
		await act(async () => {
			bar.click()
			bar.click()
		})
		expect(contents()).toEqual(['7-day window'])
	})

	it('tells the agent to send a stacked message once when the stack and the bar both send', async () => {
		const drafts = [
			{ id: 'kenneth', label: 'LinkedIn DM', to: 'Kenneth', body: 'Hej Kenneth' },
			{ id: 'dan', label: 'Connection note', to: 'Dan', body: 'Hej Dan' },
		]
		testState.__items = [
			buildItem('b', 'Two messages', { label: 'Send', destructive: true }, drafts),
		]
		await renderFeed()

		await userEvent.click(screen.getByRole('button', { name: 'send kenneth' }))
		await flush()
		await userEvent.click(screen.getByRole('button', { name: 'bar Two messages' }))
		await flush()

		const sent = contents()
		expect(sent.filter((c) => String(c).includes('(kenneth)'))).toHaveLength(1)
		expect(sent.filter((c) => String(c).includes('(dan)'))).toHaveLength(1)
		// The whole-card "Send" is not posted on top of the per-message ones.
		expect(sent).not.toContain('Send')
	})

	it('shows what Take every suggested option will do and posts nothing until confirmed', async () => {
		testState.__items = [
			buildItem('c', 'Pick a window', { label: '7-day window' }),
			buildItem('d', 'Archive the old plan', { label: 'Archive it' }),
		]
		await renderFeed()

		await userEvent.click(screen.getByRole('button', { name: /Take every suggested option/ }))
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText('Pick a window')).toBeInTheDocument()
		expect(within(dialog).getByText('7-day window')).toBeInTheDocument()
		expect(within(dialog).getByText('Archive the old plan')).toBeInTheDocument()
		expect(testState.__createCalls).toHaveLength(0)

		const confirm = within(dialog).getByRole('button', { name: 'Answer 2 cards' })
		await act(async () => {
			confirm.click()
			confirm.click()
		})
		await flush()
		expect(contents().sort()).toEqual(['7-day window', 'Archive it'])
	})

	it('leaves sending options out of the bulk path', async () => {
		testState.__items = [
			buildItem('e', 'Pick a window', { label: '7-day window' }),
			buildItem('f', 'Reply to Kenneth', { label: 'Send', destructive: true }),
		]
		await renderFeed()

		await userEvent.click(screen.getByRole('button', { name: /Take every suggested option \(1\)/ }))
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).queryByText('Reply to Kenneth')).not.toBeInTheDocument()
		await userEvent.click(within(dialog).getByRole('button', { name: 'Answer 1 card' }))
		await flush()
		expect(contents()).toEqual(['7-day window'])
	})
})

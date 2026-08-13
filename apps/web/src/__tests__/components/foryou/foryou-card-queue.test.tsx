import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotificationResponse } from '@/lib/api'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const bulkRespondMutate = vi.fn()
const singleRespondMutate = vi.fn()

vi.mock('@/hooks/use-notifications', () => ({
	useBulkRespondNotifications: () => ({ mutate: bulkRespondMutate, isPending: false }),
	useRespondNotification: () => ({ mutate: singleRespondMutate, isPending: false }),
}))

import { ForYouCardQueue } from '@/components/foryou/foryou-card-queue'

function buildNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: crypto.randomUUID(),
		workspaceId: 'ws-1',
		type: 'needs_input',
		title: 'Approve the send list',
		content: null,
		metadata: null,
		sourceActorId: crypto.randomUUID(),
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		expiresAt: null,
		defaultAction: null,
		dispatchAt: null,
		wakeDispatched: false,
		createdAt: '2026-08-13T10:00:00Z',
		updatedAt: '2026-08-13T10:00:00Z',
		...overrides,
	}
}

describe('ForYouCardQueue', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the empty state when no notifications are present', () => {
		render(<ForYouCardQueue workspaceId="ws-1" notifications={[]} />)
		expect(screen.getByText("You're caught up")).toBeInTheDocument()
		expect(screen.queryByTestId('foryou-bucket')).not.toBeInTheDocument()
	})

	it('renders each of the four buckets when seeded with one notification per type', () => {
		const decision = buildNotification({
			id: 'n-decision',
			type: 'needs_input',
			title: 'Approve draft',
			objectId: 'obj-decision',
			metadata: { options: [{ label: 'Approve', value: 'approve', default: true }] },
		})
		const waiting = buildNotification({
			id: 'n-waiting',
			status: 'resolved',
			title: 'Waking source agent',
			objectId: 'obj-waiting',
			resolvedAt: '2026-08-13T09:59:59Z',
			dispatchAt: '2026-08-13T10:00:05Z',
			wakeDispatched: false,
		})
		const fyi = buildNotification({
			id: 'n-fyi',
			type: 'good_news',
			title: 'Loop finished',
			objectId: 'obj-fyi',
			metadata: { attention_needed: true },
		})
		const handled = buildNotification({
			id: 'n-handled',
			status: 'resolved',
			title: 'Approved the send',
			objectId: 'obj-handled',
			resolvedAt: '2026-08-13T05:00:00Z',
			wakeDispatched: true,
		})

		render(<ForYouCardQueue workspaceId="ws-1" notifications={[decision, waiting, fyi, handled]} />)

		const buckets = screen.getAllByTestId('foryou-bucket')
		expect(buckets.map((el) => el.dataset.bucket)).toEqual([
			'decision',
			'waiting',
			'fyi',
			'handled',
		])
		expect(screen.getByRole('heading', { name: 'Decision needed' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Waiting on agents' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'FYI' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Handled today' })).toBeInTheDocument()
	})

	it('collapses same-objectId notifications into one grouped card with a bulk action', () => {
		const objectId = 'obj-shared'
		const first = buildNotification({
			id: 'n-1',
			objectId,
			title: 'Approve post A',
			metadata: {
				options: [{ label: 'Send', value: 'send', default: true }],
				recommendation: 'send',
			},
			updatedAt: '2026-08-13T10:05:00Z',
		})
		const second = buildNotification({
			id: 'n-2',
			objectId,
			title: 'Approve post B',
			metadata: {
				options: [{ label: 'Send', value: 'send', default: true }],
				recommendation: 'send',
			},
			updatedAt: '2026-08-13T10:04:00Z',
		})
		const standalone = buildNotification({
			id: 'n-3',
			objectId: 'obj-other',
			title: 'Approve post C',
			metadata: { options: [{ label: 'Send', value: 'send' }] },
		})

		render(<ForYouCardQueue workspaceId="ws-1" notifications={[first, second, standalone]} />)

		const cards = screen.getAllByTestId('foryou-group-card')
		expect(cards).toHaveLength(2)

		const groupedCard = cards.find((el) => el.dataset.objectId === objectId)
		expect(groupedCard).toBeTruthy()
		expect(groupedCard?.dataset.groupSize).toBe('2')

		const bulk = screen.getByTestId('foryou-bulk-approve')
		expect(bulk).toHaveTextContent(/approve all 2/i)
	})

	it('fires bulk-respond with all collapsed ids and the shared recommendation', () => {
		const objectId = 'obj-batch'
		const items = [
			buildNotification({
				id: 'nid-1',
				objectId,
				title: 'A',
				metadata: {
					options: [{ label: 'Send', value: 'send' }],
					recommendation: 'send-it',
				},
			}),
			buildNotification({
				id: 'nid-2',
				objectId,
				title: 'B',
				metadata: {
					options: [{ label: 'Send', value: 'send' }],
					recommendation: 'send-it',
				},
			}),
		]

		render(<ForYouCardQueue workspaceId="ws-1" notifications={items} />)

		const bulk = screen.getByTestId('foryou-bulk-approve')
		fireEvent.click(bulk)

		expect(bulkRespondMutate).toHaveBeenCalledTimes(1)
		expect(bulkRespondMutate.mock.calls[0][0]).toEqual({
			ids: ['nid-1', 'nid-2'],
			response: 'send-it',
		})
	})

	it('disables bulk-approve when no recommendation or default action is available', () => {
		const objectId = 'obj-empty'
		const items = [
			buildNotification({
				id: 'a',
				objectId,
				metadata: { options: [{ label: 'Approve', value: 'approve' }] },
			}),
			buildNotification({
				id: 'b',
				objectId,
				metadata: { options: [{ label: 'Approve', value: 'approve' }] },
			}),
		]

		render(<ForYouCardQueue workspaceId="ws-1" notifications={items} />)

		const bulk = screen.getByTestId('foryou-bulk-approve')
		expect(bulk).toBeDisabled()
		expect(bulk).toHaveTextContent(/no recommendation/i)
	})

	it('single-item groups render per-option buttons that call respond', () => {
		const notification = buildNotification({
			id: 'solo',
			objectId: 'obj-solo',
			title: 'One decision',
			metadata: {
				options: [
					{ label: 'Approve', value: 'approve', default: true },
					{ label: 'Reject', value: 'reject' },
				],
			},
		})

		render(<ForYouCardQueue workspaceId="ws-1" notifications={[notification]} />)

		const buttons = screen.getAllByTestId('foryou-single-option')
		expect(buttons.map((b) => b.dataset.optionValue)).toEqual(['approve', 'reject'])

		fireEvent.click(buttons[0])
		expect(singleRespondMutate).toHaveBeenCalledWith(
			{ id: 'solo', response: 'approve' },
			expect.any(Object),
		)
	})
})

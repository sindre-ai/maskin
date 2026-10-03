import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ApnsSender } from '../../services/apns'
import { NotificationPushFanout } from '../../services/notification-push'
import { createTestContext } from '../setup'

const event = {
	workspace_id: 'ws',
	actor_id: 'a',
	action: 'created',
	entity_type: 'notification',
	entity_id: 'n-1',
	event_id: '1',
}
const notif = (over: Record<string, unknown> = {}) => ({
	id: 'n-1',
	workspaceId: 'ws',
	title: 'Hello',
	content: 'World',
	metadata: null,
	sourceActorId: 'agent',
	targetActorId: 'human',
	objectId: 'obj',
	...over,
})

function setup(rows: unknown[], enabled = true, queue?: unknown[][]) {
	const { db, mockResults } = createTestContext()
	mockResults.select = rows
	if (queue) mockResults.selectQueue = queue
	const sender = { isEnabled: () => enabled, sendToActor: vi.fn() }
	const bridge = new EventEmitter()
	const fanout = new NotificationPushFanout(db, bridge as never, sender as unknown as ApnsSender)
	return { fanout, sender, bridge }
}

describe('NotificationPushFanout', () => {
	it('pushes to the target actor of a created notification', async () => {
		const { fanout, sender } = setup([notif()])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledWith(
			'human',
			expect.objectContaining({ title: 'Hello', notificationId: 'n-1', objectId: 'obj' }),
		)
	})

	it('skips untargeted and self-targeted notifications', async () => {
		for (const over of [{ targetActorId: null }, { targetActorId: 'agent' }]) {
			const { fanout, sender } = setup([notif(over)])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).not.toHaveBeenCalled()
		}
	})

	it('does no DB work when push is disabled', async () => {
		const { fanout, sender } = setup([notif()], false)
		await fanout.handleEvent(event)
		expect(sender.sendToActor).not.toHaveBeenCalled()
	})

	it('only reacts to notification/created events on the bridge', async () => {
		const { fanout, sender, bridge } = setup([notif()])
		fanout.start()
		bridge.emit('event', { ...event, entity_type: 'object' })
		await new Promise((r) => setTimeout(r, 10))
		expect(sender.sendToActor).not.toHaveBeenCalled()
		bridge.emit('event', event)
		await vi.waitFor(() => expect(sender.sendToActor).toHaveBeenCalled())
	})

	describe('decision pushes', () => {
		const decision = {
			title: 'Is the onboarding bet worth running?',
			summary: '3 of 5 signups stall on step 2.',
			ask: 'This changes what every new customer sees first, so I will not ship it alone.',
			options: [
				{ label: 'Ship it', recommended: true, consequences: ['a', 'b'] },
				{ label: 'Hold', consequences: ['c', 'd'] },
			],
		}
		const comment = (over: Record<string, unknown> = {}) => ({
			id: 99,
			data: { content: 'World', mentions: ['human'], decision, parentEventId: 12, ...over },
		})
		const needsInput = notif({ type: 'needs_input' })

		it('attaches the decision, using its title and ask as the alert', async () => {
			const { fanout, sender } = setup([], true, [[needsInput], [comment()]])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({
					title: decision.title,
					body: decision.ask,
					decision: {
						eventId: 99,
						parentEventId: 12,
						objectId: 'obj',
						options: [{ label: 'Ship it' }, { label: 'Hold' }],
						recommended: 0,
					},
				}),
			)
		})

		it('falls back to a plain push when the comment does not match the notification', async () => {
			for (const over of [{ content: 'other' }, { mentions: ['someone-else'] }, { decision: {} }]) {
				const { fanout, sender } = setup([], true, [[needsInput], [comment(over)]])
				await fanout.handleEvent(event)
				expect(sender.sendToActor).toHaveBeenCalledWith(
					'human',
					expect.objectContaining({ title: 'Hello', decision: null }),
				)
			}
		})

		it('does not look for a decision on other notification types', async () => {
			const { fanout, sender } = setup([notif({ type: 'good_news' })])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({ decision: null }),
			)
		})
	})
})

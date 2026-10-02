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

function setup(rows: unknown[], enabled = true) {
	const { db, mockResults } = createTestContext()
	mockResults.select = rows
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
})

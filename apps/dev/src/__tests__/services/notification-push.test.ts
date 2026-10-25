import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationPushFanout } from '../../services/notification-push'
import type { PushChannel } from '../../services/push-types'
import { createTestContext } from '../setup'

const flagOn = vi.hoisted(() => ({ value: false }))
vi.mock('../../lib/feature-flags', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/feature-flags')>()),
	isFlagEnabled: () => flagOn.value,
}))

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
	metadata: { push_category: 'conversation' },
	status: 'pending',
	type: 'message',
	createdAt: new Date(),
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
	const fanout = new NotificationPushFanout(db, bridge as never, [sender as unknown as PushChannel])
	return { fanout, sender, bridge }
}

describe('NotificationPushFanout with push-human-decisions-only', () => {
	afterEach(() => {
		flagOn.value = false
	})

	it('keeps a plain @mention in the app', async () => {
		flagOn.value = true
		const { fanout, sender } = setup([], true, [
			[notif({ type: 'needs_input', metadata: { source: 'comment_mention', from_agent: true } })],
			[], // preferences
			[], // decision lookup: no decision block
		])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).not.toHaveBeenCalled()
	})

	it('still pushes the same @mention when the flag is off', async () => {
		const { fanout, sender } = setup([], true, [
			[notif({ type: 'needs_input', metadata: { source: 'comment_mention', from_agent: true } })],
			[], // preferences
			[], // decision lookup
			[{ value: 1 }],
		])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledTimes(1)
	})

	it('leads the push text with the deadline and collapses on the object', async () => {
		flagOn.value = true
		const { fanout, sender } = setup([], true, [
			[notif({ type: 'needs_input', metadata: { due_at: '2099-10-26T08:00:00Z' } })],
			[], // preferences
			[], // decision lookup
			[{ value: 2 }],
		])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledWith(
			'human',
			expect.objectContaining({
				body: 'Before Mon 26 Oct 08:00 UTC · World',
				collapseKey: 'object:obj',
			}),
		)
	})
})

describe('NotificationPushFanout', () => {
	it('pushes to the target actor of a created notification', async () => {
		const { fanout, sender } = setup([notif()])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledWith(
			'human',
			expect.objectContaining({ title: 'Hello', notificationId: 'n-1', objectId: 'obj' }),
		)
	})

	it('marks a needs_input push time-sensitive and carries the pending count as badge', async () => {
		const { fanout, sender } = setup([], true, [
			[notif({ type: 'needs_input', metadata: null })],
			[], // preferences
			[], // decision lookup
			[{ value: 4 }],
		])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledWith(
			'human',
			expect.objectContaining({ interruption: 'time-sensitive', badge: 4 }),
		)
	})

	it('sends an active push with no badge when the count is unavailable', async () => {
		const { fanout, sender } = setup([], true, [[notif()], [], []])
		await fanout.handleEvent(event)
		expect(sender.sendToActor).toHaveBeenCalledWith(
			'human',
			expect.objectContaining({ interruption: 'active', badge: null }),
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
		const needsInput = notif({ type: 'needs_input', metadata: null })

		it('attaches the decision, using its title and ask as the alert', async () => {
			const { fanout, sender } = setup([], true, [[needsInput], [], [comment()]])
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

		it('forwards destructive options to the push decision', async () => {
			const risky = {
				...decision,
				options: [
					{ label: 'Send', recommended: true, destructive: true, consequences: ['a', 'b'] },
					{ label: 'Hold', consequences: ['c', 'd'] },
				],
			}
			const { fanout, sender } = setup([], true, [[needsInput], [], [comment({ decision: risky })]])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({
					decision: expect.objectContaining({
						options: [{ label: 'Send', destructive: true }, { label: 'Hold' }],
					}),
				}),
			)
		})

		it('falls back to a plain push when the comment does not match the notification', async () => {
			for (const over of [{ content: 'other' }, { mentions: ['someone-else'] }, { decision: {} }]) {
				const { fanout, sender } = setup([], true, [[needsInput], [], [comment(over)]])
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
	describe('multiple channels', () => {
		function setupChannels(channels: PushChannel[]) {
			const { db, mockResults } = createTestContext()
			mockResults.select = [notif()]
			const fanout = new NotificationPushFanout(db, new EventEmitter() as never, channels)
			return fanout
		}

		it('sends the same message to every enabled channel and skips disabled ones', async () => {
			const apns = { isEnabled: () => true, sendToActor: vi.fn() }
			const web = { isEnabled: () => true, sendToActor: vi.fn() }
			const off = { isEnabled: () => false, sendToActor: vi.fn() }
			await setupChannels([apns, web, off]).handleEvent(event)
			expect(apns.sendToActor).toHaveBeenCalledTimes(1)
			expect(web.sendToActor).toHaveBeenCalledWith('human', apns.sendToActor.mock.calls[0]?.[1])
			expect(off.sendToActor).not.toHaveBeenCalled()
		})

		it('still delivers on the other channels when one rejects', async () => {
			const broken = {
				isEnabled: () => true,
				sendToActor: vi.fn().mockRejectedValue(new Error('x')),
			}
			const web = { isEnabled: () => true, sendToActor: vi.fn() }
			await setupChannels([broken, web]).handleEvent(event)
			expect(web.sendToActor).toHaveBeenCalledTimes(1)
		})
	})
	describe('push policy wiring', () => {
		const forYou = (id: string, over: Record<string, unknown> = {}) =>
			notif({
				id,
				type: 'needs_input',
				metadata: { kind: 'for_you', rank: 1, headline: 'x', ...over },
			})

		it('does not push a notification that carries no push category (digest-only)', async () => {
			const { fanout, sender } = setup([notif({ type: 'good_news', metadata: null })])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).not.toHaveBeenCalled()
		})

		it('skips a category the actor switched off', async () => {
			const prefs = { categories: { conversation: false }, mutedWorkspaceIds: [] }
			const { fanout, sender } = setup([], true, [[notif()], [prefs]])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).not.toHaveBeenCalled()
		})

		it('passes the collapse key through and downgrades to passive in quiet hours', async () => {
			const prefs = {
				timezone: null,
				quietHoursStart: 0,
				quietHoursEnd: 1439,
				categories: {},
				mutedWorkspaceIds: [],
			}
			const n = notif({ metadata: { push_category: 'conversation', push_collapse_key: 'chat:c1' } })
			const { fanout, sender } = setup([], true, [[n], [prefs], [{ value: 1 }]])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({ collapseKey: 'chat:c1', interruption: 'passive' }),
			)
		})

		it('rate limits a second push with the same collapse key', async () => {
			const n = notif({ metadata: { push_category: 'conversation', push_collapse_key: 'chat:c1' } })
			const { fanout, sender } = setup([], true, [
				[n],
				[],
				[],
				[{ value: 1 }],
				[{ ...n, id: 'n-2' }],
				[],
			])
			await fanout.handleEvent(event)
			await fanout.handleEvent({ ...event, entity_id: 'n-2' })
			expect(sender.sendToActor).toHaveBeenCalledTimes(1)
		})

		it('sends one rollup instead of a push per For You card', async () => {
			const others = [
				{ id: 'c1', metadata: { kind: 'for_you' }, createdAt: new Date() },
				{ id: 'c2', metadata: { kind: 'for_you' }, createdAt: new Date() },
			]
			const { fanout, sender } = setup([], true, [[forYou('n-1')], [], others, [{ value: 3 }]])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledTimes(1)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({
					title: '3 things need you',
					collapseKey: 'foryou:ws',
					interruption: 'time-sensitive',
					badge: 3,
					objectId: null,
					decision: null,
				}),
			)
		})

		it('never rolls a critical For You card up', async () => {
			const { fanout, sender } = setup([], true, [
				[forYou('n-1', { priority: 'critical' })],
				[],
				[],
				[{ value: 3 }],
			])
			await fanout.handleEvent(event)
			expect(sender.sendToActor).toHaveBeenCalledWith(
				'human',
				expect.objectContaining({ title: 'Hello', interruption: 'time-sensitive' }),
			)
		})

		describe('push_delay_seconds', () => {
			const delayed = notif({
				metadata: {
					push_category: 'conversation',
					push_delay_seconds: 30,
					conversation_id: '11111111-1111-4111-8111-111111111111',
					message_id: 5,
				},
			})
			afterEach(() => vi.useRealTimers())

			it('holds the push, then skips it when the conversation was read meanwhile', async () => {
				vi.useFakeTimers()
				const { fanout, sender } = setup([], true, [
					[delayed],
					[], // preferences
					[delayed], // re-read after the wait
					[{ lastRead: 5 }], // participant read up to message 5
				])
				await fanout.handleEvent(event)
				expect(sender.sendToActor).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(31_000)
				expect(sender.sendToActor).not.toHaveBeenCalled()
			})

			it('sends once after the wait when still unread, and never twice', async () => {
				vi.useFakeTimers()
				const { fanout, sender } = setup([], true, [
					[delayed],
					[], // preferences, first event
					[delayed],
					[], // preferences, duplicate event
					[delayed], // re-read after the wait
					[{ lastRead: 3 }], // read check
					[], // preferences
					[{ value: 1 }], // badge
				])
				await fanout.handleEvent(event)
				await fanout.handleEvent(event) // duplicate event: a timer is already pending
				expect(sender.sendToActor).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(31_000)
				expect(sender.sendToActor).toHaveBeenCalledTimes(1)
			})

			it('still sends a push-only row (stored seen) after the wait', async () => {
				vi.useFakeTimers()
				const pushOnly = {
					...delayed,
					status: 'seen',
					metadata: { ...(delayed.metadata as Record<string, unknown>), push_only: true },
				}
				const { fanout, sender } = setup([], true, [
					[pushOnly],
					[], // preferences
					[pushOnly], // re-read after the wait
					[{ lastRead: 3 }], // read check
					[], // preferences
					[{ value: 0 }], // badge
				])
				await fanout.handleEvent(event)
				await vi.advanceTimersByTimeAsync(31_000)
				expect(sender.sendToActor).toHaveBeenCalledTimes(1)
			})

			it('drops a seen row that is not push-only', async () => {
				vi.useFakeTimers()
				const { fanout, sender } = setup([], true, [
					[delayed],
					[],
					[{ ...delayed, status: 'seen' }],
				])
				await fanout.handleEvent(event)
				await vi.advanceTimersByTimeAsync(31_000)
				expect(sender.sendToActor).not.toHaveBeenCalled()
			})

			it('drops the push when the notification is no longer pending', async () => {
				vi.useFakeTimers()
				const { fanout, sender } = setup([], true, [
					[delayed],
					[],
					[{ ...delayed, status: 'resolved' }],
				])
				await fanout.handleEvent(event)
				await vi.advanceTimersByTimeAsync(31_000)
				expect(sender.sendToActor).not.toHaveBeenCalled()
			})
		})
	})
})

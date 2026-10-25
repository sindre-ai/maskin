import { describe, expect, it } from 'vitest'
import {
	DEFAULT_PUSH_PREFS,
	type PolicyNotification,
	PushLedger,
	type PushPrefs,
	type RecentPush,
	dueAtOf,
	evaluatePush,
	formatDeadline,
	inQuietHours,
	localMinuteOfDay,
	pushCategoryOf,
	withDeadline,
} from '../../services/push-policy'

const NOW = new Date('2026-06-01T12:00:00Z')
const MIN = 60_000
const ACTOR = 'human'

const note = (over: Partial<PolicyNotification> = {}): PolicyNotification => ({
	id: 'n-new',
	type: 'message',
	workspaceId: 'ws',
	targetActorId: ACTOR,
	createdAt: NOW,
	metadata: {},
	...over,
})
const prefs = (over: Partial<PushPrefs> = {}): PushPrefs => ({ ...DEFAULT_PUSH_PREFS, ...over })
const recent = (over: Partial<RecentPush> = {}): RecentPush => ({
	notificationId: `r-${Math.random()}`,
	actorId: ACTOR,
	workspaceId: 'ws',
	category: 'conversation',
	collapseKey: null,
	at: NOW.getTime() - MIN,
	sent: true,
	forYou: false,
	critical: false,
	rollup: false,
	...over,
})
const forYouNote = (over: Record<string, unknown> = {}) =>
	note({ type: 'needs_input', metadata: { kind: 'for_you', ...over } })
const card = (over: Partial<RecentPush> = {}) =>
	recent({ category: 'needs_you', forYou: true, sent: false, ...over })

const run = (
	n: PolicyNotification,
	opts: { prefs?: PushPrefs; recentPushes?: RecentPush[]; now?: Date } = {},
) =>
	evaluatePush({
		notification: n,
		category: pushCategoryOf(n),
		prefs: opts.prefs ?? DEFAULT_PUSH_PREFS,
		now: opts.now ?? NOW,
		recentPushes: opts.recentPushes ?? [],
	})

describe('pushCategoryOf', () => {
	it('infers needs_you for needs_input and digest for everything else', () => {
		expect(pushCategoryOf(note({ type: 'needs_input' }))).toBe('needs_you')
		expect(pushCategoryOf(note({ type: 'good_news' }))).toBe('digest')
	})
	it('honours a valid metadata.push_category and ignores an invalid one', () => {
		expect(pushCategoryOf(note({ metadata: { push_category: 'conversation' } }))).toBe(
			'conversation',
		)
		expect(pushCategoryOf(note({ metadata: { push_category: 'bogus' } }))).toBe('digest')
	})
})

describe('categories and muting', () => {
	const conv = note({ metadata: { push_category: 'conversation' } })

	it('sends needs_you time-sensitive and conversation active', () => {
		expect(run(note({ type: 'needs_input' }))).toMatchObject({
			action: 'send',
			interruption: 'time-sensitive',
		})
		expect(run(conv)).toMatchObject({ action: 'send', interruption: 'active' })
	})

	it('skips a disabled category, including needs_you', () => {
		const off = (c: string) =>
			prefs({ categories: { ...DEFAULT_PUSH_PREFS.categories, [c]: false } })
		expect(run(conv, { prefs: off('conversation') })).toMatchObject({
			action: 'skip',
			reason: 'category-disabled',
		})
		expect(run(note({ type: 'needs_input' }), { prefs: off('needs_you') }).action).toBe('skip')
	})

	it('skips digest and tips unless push_force is set', () => {
		for (const push_category of ['digest', 'tips']) {
			expect(run(note({ metadata: { push_category } }))).toMatchObject({
				action: 'skip',
				reason: 'digest-only',
			})
			expect(run(note({ metadata: { push_category, push_force: true } })).action).toBe('send')
		}
		expect(run(note({ type: 'good_news' })).reason).toBe('digest-only')
	})

	it('skips a muted workspace but still delivers needs_you as active', () => {
		const muted = prefs({ mutedWorkspaceIds: ['ws'] })
		expect(run(conv, { prefs: muted })).toMatchObject({ action: 'skip', reason: 'workspace-muted' })
		expect(run(note({ type: 'needs_input' }), { prefs: muted })).toMatchObject({
			action: 'send',
			interruption: 'active',
		})
		expect(run(conv, { prefs: prefs({ mutedWorkspaceIds: ['other'] }) }).action).toBe('send')
	})
})

describe('quiet hours', () => {
	it('computes local minutes in the actor timezone, UTC when null or invalid', () => {
		expect(localMinuteOfDay(NOW, null)).toBe(720)
		expect(localMinuteOfDay(NOW, 'Not/AZone')).toBe(720)
		expect(localMinuteOfDay(NOW, 'Europe/Oslo')).toBe(14 * 60) // CEST, UTC+2
		expect(localMinuteOfDay(NOW, 'America/New_York')).toBe(8 * 60)
		expect(localMinuteOfDay(new Date('2026-06-01T22:30:00Z'), 'Asia/Kolkata')).toBe(4 * 60)
	})

	it('handles a same-day window with an exclusive end', () => {
		const p = prefs({ quietHoursStart: 12 * 60, quietHoursEnd: 13 * 60 })
		expect(inQuietHours(p, NOW)).toBe(true)
		expect(inQuietHours(p, new Date('2026-06-01T13:00:00Z'))).toBe(false)
		expect(inQuietHours(p, new Date('2026-06-01T11:59:00Z'))).toBe(false)
	})

	it('wraps a window past midnight', () => {
		const p = prefs({ quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60 })
		expect(inQuietHours(p, new Date('2026-06-01T23:00:00Z'))).toBe(true)
		expect(inQuietHours(p, new Date('2026-06-02T02:00:00Z'))).toBe(true)
		expect(inQuietHours(p, new Date('2026-06-02T06:59:00Z'))).toBe(true)
		expect(inQuietHours(p, new Date('2026-06-02T07:00:00Z'))).toBe(false)
		expect(inQuietHours(p, NOW)).toBe(false)
	})

	it('applies the window in the actor timezone, not the server one', () => {
		const p = prefs({ timezone: 'Europe/Oslo', quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60 })
		// 21:30Z is 23:30 in Oslo (inside); 12:00Z is 14:00 (outside)
		expect(inQuietHours(p, new Date('2026-06-01T21:30:00Z'))).toBe(true)
		expect(inQuietHours(p, NOW)).toBe(false)
		expect(inQuietHours({ ...p, timezone: null }, new Date('2026-06-01T21:30:00Z'))).toBe(false)
	})

	it('treats null or equal bounds as no quiet hours', () => {
		expect(inQuietHours(prefs({ quietHoursStart: 100, quietHoursEnd: null }), NOW)).toBe(false)
		expect(inQuietHours(prefs({ quietHoursStart: 100, quietHoursEnd: 100 }), NOW)).toBe(false)
	})

	it('downgrades to passive but never drops needs_you or conversation', () => {
		const p = prefs({ quietHoursStart: 11 * 60, quietHoursEnd: 13 * 60 })
		expect(run(note({ type: 'needs_input' }), { prefs: p })).toMatchObject({
			action: 'send',
			interruption: 'passive',
			reason: 'quiet-hours',
		})
		expect(run(note({ metadata: { push_category: 'conversation' } }), { prefs: p })).toMatchObject({
			action: 'send',
			interruption: 'passive',
		})
	})
})

describe('rate limits', () => {
	const conv = (key?: string) =>
		note({
			metadata: { push_category: 'conversation', ...(key ? { push_collapse_key: key } : {}) },
		})

	it('allows 6 conversation pushes an hour and skips the 7th', () => {
		const sent = (n: number) =>
			Array.from({ length: n }, (_, i) => recent({ at: NOW.getTime() - (i + 3) * MIN }))
		expect(run(conv(), { recentPushes: sent(5) }).action).toBe('send')
		expect(run(conv(), { recentPushes: sent(6) })).toMatchObject({
			action: 'skip',
			reason: 'rate-limit-hour',
		})
	})

	it('forgets pushes older than an hour and other actors’ pushes', () => {
		const old = Array.from({ length: 6 }, () => recent({ at: NOW.getTime() - 61 * MIN }))
		expect(run(conv(), { recentPushes: old }).action).toBe('send')
		const other = Array.from({ length: 6 }, () => recent({ actorId: 'someone-else' }))
		expect(run(conv(), { recentPushes: other }).action).toBe('send')
	})

	it('does not count unsent entries', () => {
		const unsent = Array.from({ length: 6 }, () => recent({ sent: false }))
		expect(run(conv(), { recentPushes: unsent }).action).toBe('send')
	})

	it('allows 1 push per collapse key per 2 minutes', () => {
		const one = (agoMs: number) => [recent({ collapseKey: 'chat:1', at: NOW.getTime() - agoMs })]
		expect(run(conv('chat:1'), { recentPushes: one(60_000) })).toMatchObject({
			action: 'skip',
			reason: 'rate-limit-collapse-key',
		})
		expect(run(conv('chat:1'), { recentPushes: one(121_000) }).action).toBe('send')
		expect(run(conv('chat:2'), { recentPushes: one(60_000) }).action).toBe('send')
	})

	it('allows 2 forced tips a day', () => {
		const tip = note({ metadata: { push_category: 'tips', push_force: true } })
		const tips = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				recent({ category: 'tips', at: NOW.getTime() - (i + 1) * 60 * MIN }),
			)
		expect(run(tip, { recentPushes: tips(1) }).action).toBe('send')
		expect(run(tip, { recentPushes: tips(2) })).toMatchObject({
			action: 'skip',
			reason: 'rate-limit-day',
		})
	})

	it('never rate limits needs_you', () => {
		const flood = Array.from({ length: 20 }, () => recent({ category: 'needs_you' }))
		expect(run(note({ type: 'needs_input' }), { recentPushes: flood }).action).toBe('send')
	})
})

describe('For You rollup', () => {
	it('sends individually below 3 cards in the window', () => {
		expect(run(forYouNote(), { recentPushes: [card({ notificationId: 'a' })] }).action).toBe('send')
	})

	it('rolls up when 3 cards (2 earlier + this one) landed within 10 minutes', () => {
		const v = run(forYouNote(), {
			recentPushes: [card({ notificationId: 'a' }), card({ notificationId: 'b' })],
		})
		expect(v).toMatchObject({
			action: 'rollup',
			rollupCount: 3,
			collapseKey: 'foryou:ws',
			interruption: 'time-sensitive',
		})
	})

	it('ignores cards older than 10 minutes, in other workspaces, or already counted twice', () => {
		const stale = [
			card({ notificationId: 'a', at: NOW.getTime() - 11 * MIN }),
			card({ notificationId: 'b' }),
		]
		expect(run(forYouNote(), { recentPushes: stale }).action).toBe('send')
		const elsewhere = [
			card({ notificationId: 'a', workspaceId: 'other' }),
			card({ notificationId: 'b' }),
		]
		expect(run(forYouNote(), { recentPushes: elsewhere }).action).toBe('send')
		const dupes = [card({ notificationId: 'a' }), card({ notificationId: 'a' })]
		expect(run(forYouNote(), { recentPushes: dupes }).action).toBe('send')
	})

	it('counts the current notification only once if it is also in the recent list', () => {
		const self = card({ notificationId: 'n-new' })
		expect(run(forYouNote(), { recentPushes: [self, card({ notificationId: 'a' })] }).action).toBe(
			'send',
		)
	})

	it('lets a critical or blocking card bypass the rollup, and does not count it', () => {
		const crowd = [card({ notificationId: 'a' }), card({ notificationId: 'b' })]
		expect(run(forYouNote({ priority: 'critical' }), { recentPushes: crowd }).action).toBe('send')
		expect(run(forYouNote({ blocking: true }), { recentPushes: crowd }).action).toBe('send')
		const withCritical = [
			card({ notificationId: 'a' }),
			card({ notificationId: 'b', critical: true }),
		]
		expect(run(forYouNote(), { recentPushes: withCritical }).action).toBe('send')
	})

	it('does not roll up needs_input that is not a For You card', () => {
		const crowd = [card({ notificationId: 'a' }), card({ notificationId: 'b' })]
		expect(run(note({ type: 'needs_input' }), { recentPushes: crowd }).action).toBe('send')
	})

	it('refreshes an earlier rollup quietly instead of buzzing again', () => {
		const earlier = [
			card({ notificationId: 'a' }),
			card({ notificationId: 'b', sent: true, rollup: true }),
			card({ notificationId: 'c' }),
		]
		expect(run(forYouNote(), { recentPushes: earlier })).toMatchObject({
			action: 'rollup',
			rollupCount: 4,
			interruption: 'passive',
		})
	})

	it('goes passive in quiet hours', () => {
		const p = prefs({ quietHoursStart: 11 * 60, quietHoursEnd: 13 * 60 })
		const v = run(forYouNote(), {
			prefs: p,
			recentPushes: [card({ notificationId: 'a' }), card({ notificationId: 'b' })],
		})
		expect(v).toMatchObject({ action: 'rollup', interruption: 'passive' })
	})
})

describe('push_delay_seconds', () => {
	const delayed = (ageMs: number) =>
		note({
			createdAt: new Date(NOW.getTime() - ageMs),
			metadata: { push_category: 'conversation', push_delay_seconds: 30 },
		})

	it('delays for the remaining time, then sends', () => {
		expect(run(delayed(5_000))).toMatchObject({ action: 'delay', delayMs: 25_000 })
		expect(run(delayed(30_000)).action).toBe('send')
	})

	it('ignores non-positive or non-numeric delays', () => {
		for (const push_delay_seconds of [0, -5, 'x', Number.NaN]) {
			const n = note({ metadata: { push_category: 'conversation', push_delay_seconds } })
			expect(run(n).action).toBe('send')
		}
	})
})

describe('PushLedger', () => {
	it('keeps recent entries per actor, replaces by notification id and prunes old ones', () => {
		const ledger = new PushLedger(3, 10 * MIN)
		const at = NOW.getTime()
		ledger.record(recent({ notificationId: 'a', at: at - 20 * MIN }))
		ledger.record(recent({ notificationId: 'b', at }))
		ledger.record(recent({ notificationId: 'b', at }))
		expect(ledger.recent(ACTOR, at).map((r) => r.notificationId)).toEqual(['b'])
		expect(ledger.hasSent(ACTOR, 'b')).toBe(true)
		expect(ledger.hasSent(ACTOR, 'zzz')).toBe(false)
		for (const id of ['c', 'd', 'e']) ledger.record(recent({ notificationId: id, at }))
		expect(ledger.recent(ACTOR, at)).toHaveLength(3)
	})
})

describe('evaluatePush with the human-decisions gate', () => {
	const mention = (over: Partial<PolicyNotification> = {}) =>
		note({
			type: 'needs_input',
			objectId: 'obj-1',
			metadata: { source: 'comment_mention' },
			...over,
		})
	const gated = (n: PolicyNotification, extra: { hasDecision?: boolean; gate?: boolean } = {}) =>
		evaluatePush({
			notification: n,
			category: pushCategoryOf(n),
			prefs: DEFAULT_PUSH_PREFS,
			now: NOW,
			recentPushes: [],
			gate: true,
			...extra,
		})

	it('skips a plain @mention', () => {
		expect(gated(mention())).toMatchObject({ action: 'skip', reason: 'mention-without-decision' })
	})

	it('still pushes an @mention that carries a decision block', () => {
		expect(gated(mention(), { hasDecision: true }).action).toBe('send')
	})

	it('still pushes a card or question that is not a mention', () => {
		expect(gated(note({ type: 'needs_input', metadata: {} })).action).toBe('send')
		expect(
			gated(note({ type: 'needs_input', metadata: { push_category: 'needs_you' } })).action,
		).toBe('send')
	})

	it("keeps today's behaviour when the gate is off", () => {
		expect(gated(mention(), { gate: false }).action).toBe('send')
		expect(gated(mention(), { gate: false }).collapseKey).toBeUndefined()
	})

	it('collapses on the object when the producer gave no key', () => {
		const v = gated(note({ type: 'needs_input', objectId: 'obj-9', metadata: {} }))
		expect(v.collapseKey).toBe('object:obj-9')
	})

	it('keeps a key the producer chose', () => {
		const v = gated(
			note({ type: 'needs_input', objectId: 'obj-9', metadata: { push_collapse_key: 'mine' } }),
		)
		expect(v.collapseKey).toBe('mine')
	})
})

describe('deadline text', () => {
	it('reads a valid due_at and ignores anything else', () => {
		expect(dueAtOf({ due_at: '2026-10-26T08:00:00Z' })?.toISOString()).toBe(
			'2026-10-26T08:00:00.000Z',
		)
		expect(dueAtOf({ due_at: 'soon' })).toBeNull()
		expect(dueAtOf({ due_at: 12 })).toBeNull()
		expect(dueAtOf({})).toBeNull()
	})

	it("formats in the person's timezone and falls back to UTC", () => {
		const at = new Date('2026-10-26T08:00:00Z')
		expect(formatDeadline(at, null)).toBe('Mon 26 Oct 08:00 UTC')
		expect(formatDeadline(at, 'Not/AZone')).toBe('Mon 26 Oct 08:00 UTC')
		expect(formatDeadline(at, 'Europe/Copenhagen')).toContain('09:00')
	})

	it('leads the body with the deadline, or says overdue', () => {
		const due = new Date('2026-10-26T08:00:00Z')
		expect(withDeadline('Flip the bet', due, new Date('2026-10-25T08:00:00Z'), null)).toBe(
			'Before Mon 26 Oct 08:00 UTC · Flip the bet',
		)
		expect(withDeadline(null, due, new Date('2026-10-27T08:00:00Z'), null)).toBe(
			'Overdue since Mon 26 Oct 08:00 UTC',
		)
	})
})

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { events, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createTelnyxClient,
	decodeClientState,
} from '../../lib/integrations/providers/telnyx/client'
import { applyVoiceEvent, runAppliedEffects } from '../../lib/outreach/voice/apply'
import { runDialerTick } from '../../lib/outreach/voice/dialer'
import type { DialerConfig, DialerDeps } from '../../lib/outreach/voice/dialer'
import {
	createDrizzleDialerStore,
	findWorkspacesWithDueContacts,
} from '../../lib/outreach/voice/dialer-store'
import { parseFounderActors, runDncGate } from '../../lib/outreach/voice/dnc-gate'
import type { EffectRunner } from '../../lib/outreach/voice/effects'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Thu 2026-10-01 11:00 CEST, inside the dial window. Contacts are due relative to this.
const NOW = new Date('2026-10-01T09:00:00Z')
const DUE = '2026-10-01T08:00:00.000Z'
const LATER = '2026-10-02T09:00:00.000Z'

const EXCLUSION = { founderSlugs: ['sebk'] }

const CONFIG: DialerConfig = {
	rateLimitPerMinute: 50,
	dailyCap: 500,
	fromNumber: '+4570000000',
	assistantId: 'assistant-1',
	connectionId: 'app-1',
	webhookUrl: 'https://maskin.test/api/integrations/telnyx/webhook',
}

async function seedContact(
	workspaceId: string,
	status: string,
	metadata: Record<string, unknown> = {},
	type = 'contact',
) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type,
		status,
		metadata: { owner: 'sebk', phone: '+4520123456', ...metadata },
	})
}

function deps(workspaceId: string, over: Partial<DialerDeps> = {}) {
	const store = createDrizzleDialerStore(db)
	const createCall = vi.fn(async () => ({
		callControlId: `call-${Math.random()}`,
		callSessionId: null,
	}))
	const d: DialerDeps = {
		store,
		telnyx: { createCall },
		gate: {
			founders: parseFounderActors(JSON.stringify({ sebk: getTestActorId() })),
			findActor: async () => ({ type: 'human' }),
			robinson: { has: () => false },
		},
		config: CONFIG,
		autosendEnabled: true,
		actorId: getTestActorId(),
		now: () => NOW,
		...over,
	}
	return { d, createCall, store, workspaceId }
}

async function freshWorkspace() {
	return insertWorkspace(db, getTestActorId())
}

async function statusOf(id: string) {
	const [row] = await db.select({ status: objects.status }).from(objects).where(eq(objects.id, id))
	return row?.status
}

async function attemptsOf(id: string) {
	const [row] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(eq(objects.id, id))
	return (row?.metadata as { dial_attempt_n?: number } | null)?.dial_attempt_n
}

describe('voice dialer against real Postgres', () => {
	describe('queue read', () => {
		it('returns voice_queued (null or due) and due retry statuses, and nothing else', async () => {
			const ws = await freshWorkspace()
			const queuedNull = await seedContact(ws.id, 'voice_queued')
			const queuedDue = await seedContact(ws.id, 'voice_queued', { next_dial_at: DUE })
			const noAnswer = await seedContact(ws.id, 'voice_no_answer', { next_dial_at: DUE })
			const busy = await seedContact(ws.id, 'voice_busy', { next_dial_at: DUE })
			const voicemail = await seedContact(ws.id, 'voice_voicemail', { next_dial_at: DUE })
			// None of these may match.
			const queuedLater = await seedContact(ws.id, 'voice_queued', { next_dial_at: LATER })
			const noAnswerLater = await seedContact(ws.id, 'voice_no_answer', { next_dial_at: LATER })
			const retryWithoutDate = await seedContact(ws.id, 'voice_busy')
			const failed = await seedContact(ws.id, 'voice_failed', { next_dial_at: DUE })
			const dialing = await seedContact(ws.id, 'voice_dialing', { next_dial_at: DUE })
			const declined = await seedContact(ws.id, 'voice_declined')
			const notAContact = await seedContact(ws.id, 'voice_queued', {}, 'task')
			const other = await freshWorkspace()
			const otherWorkspace = await seedContact(other.id, 'voice_queued')

			const { store } = deps(ws.id)
			const queue = await store.readQueue(ws.id, NOW, 50, EXCLUSION)
			const ids = queue.map((c) => c.id)

			expect(ids).toEqual(
				expect.arrayContaining(
					[queuedNull, queuedDue, noAnswer, busy, voicemail].map((c) => c?.id),
				),
			)
			expect(ids).toHaveLength(5)
			for (const excluded of [
				queuedLater,
				noAnswerLater,
				retryWithoutDate,
				failed,
				dialing,
				declined,
				notAContact,
				otherWorkspace,
			]) {
				expect(ids).not.toContain(excluded?.id)
			}
			const retry = queue.find((c) => c.id === noAnswer?.id)
			expect(retry).toMatchObject({ status: 'voice_no_answer', nextDialAt: DUE })
		})

		it('orders by next_dial_at, falling back to created_at, and honours the limit', async () => {
			const ws = await freshWorkspace()
			const later = await seedContact(ws.id, 'voice_no_answer', {
				next_dial_at: '2026-10-01T08:30:00.000Z',
			})
			const earlier = await seedContact(ws.id, 'voice_busy', {
				next_dial_at: '2026-10-01T07:00:00.000Z',
			})
			const { store } = deps(ws.id)
			expect((await store.readQueue(ws.id, NOW, 50, EXCLUSION)).map((c) => c.id)).toEqual([
				earlier?.id,
				later?.id,
			])
			expect(await store.readQueue(ws.id, NOW, 1, EXCLUSION)).toHaveLength(1)
		})

		it('finds only workspaces that have due contacts', async () => {
			const due = await freshWorkspace()
			const idle = await freshWorkspace()
			await seedContact(due.id, 'voice_no_answer', { next_dial_at: DUE })
			await seedContact(idle.id, 'voice_no_answer', { next_dial_at: LATER })
			const found = await findWorkspacesWithDueContacts(db, NOW)
			expect(found).toContain(due.id)
			expect(found).not.toContain(idle.id)
		})
	})

	describe('permanently refused contacts and the queue read', () => {
		// What the dialer stamps with a refusal. Only its presence matters to the read.
		const STAMP = {
			dnc_refusal: { check: 'hold', reason: 'stamped by an earlier tick', at: DUE },
		}
		const OK = { owner: 'sebk', phone: '+4520123456' }

		async function readIds(workspaceId: string, exclusion = EXCLUSION) {
			const { store } = deps(workspaceId)
			return (await store.readQueue(workspaceId, NOW, 50, exclusion)).map((c) => c.id)
		}

		// One row per permanent cause the read mirrors, then the values the gate accepts that a
		// naive SQL port would reject. For every row the read must agree with the real gate.
		const CASES: [string, Record<string, unknown>][] = [
			['approval_hold set', { ...OK, approval_hold: true }],
			['held_reason set', { ...OK, held_reason: 'legal' }],
			['approval_hold false', { ...OK, approval_hold: false }],
			['held_reason empty', { ...OK, held_reason: '' }],
			['protect true', { ...OK, protect: true }],
			['protected as the string " TRUE "', { ...OK, protected: ' TRUE ' }],
			['protected false', { ...OK, protected: false }],
			['tags array with Protected', { ...OK, tags: ['sales', ' Protected '] }],
			['tags string with do-not-contact', { ...OK, tags: 'sales, DO-NOT-CONTACT' }],
			['tags array without a protect tag', { ...OK, tags: ['sales', 'protector'] }],
			['role investor', { ...OK, role: 'investor' }],
			['lead_source investor_pipeline', { ...OK, lead_source: 'investor_pipeline' }],
			['role something else', { ...OK, role: 'founder' }],
			['3 dials made', { ...OK, dial_attempt_n: 3 }],
			['2 dials made', { ...OK, dial_attempt_n: 2 }],
			['no phone', { owner: 'sebk' }],
			['phone that is not a number', { ...OK, phone: 'call me' }],
			['phone stored as a JSON number', { ...OK, phone: 4520123456 }],
			['phone with a non-Danish prefix', { ...OK, phone: '+4670123456' }],
			['phone as 8 digits', { ...OK, phone: '20123456' }],
			['phone with 0045 and spaces', { ...OK, phone: '0045 20 12 34 56' }],
			['phone with a no-break space', { ...OK, phone: '+45 20 12 34 56' }],
			['phone with brackets and dashes', { ...OK, phone: '(+45) 20-12-34-56' }],
			['no owner', { phone: '+4520123456' }],
			['owner not a string', { ...OK, owner: 7 }],
			['owner not a founder', { ...OK, owner: 'rune' }],
			['owner in another case with padding', { ...OK, owner: '\tSebk\n' }],
		]

		it.each(CASES)(
			'agrees with the gate when the contact is stamped and has %s',
			async (_n, metadata) => {
				const ws = await freshWorkspace()
				const c = await insertObject(db, ws.id, getTestActorId(), {
					type: 'contact',
					status: 'voice_queued',
					metadata: { ...metadata, ...STAMP },
				})
				const { d } = deps(ws.id)
				const verdict = await runDncGate(
					{ id: c?.id ?? '', status: 'voice_queued', metadata },
					{ ...d.gate, now: NOW },
				)
				expect(verdict.pass === false && verdict.check).not.toBe('time_of_day')
				expect((await readIds(ws.id)).includes(c?.id ?? '')).toBe(verdict.pass)
			},
		)

		it('reads a contact with a permanent cause but no stamp, so the first tick records the refusal', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', { approval_hold: true })
			expect(await readIds(ws.id)).toEqual([c?.id])
			const { d } = deps(ws.id)
			await runDialerTick(ws.id, d)
			expect(await readIds(ws.id)).toEqual([])
		})

		describe('Robinson-listed', () => {
			const listed = (phone: string) => ({
				dnc_refusal: {
					check: 'robinson',
					reason: 'number is on the Robinson list',
					at: DUE,
					phone,
				},
			})

			it('excludes a contact while the stamped number still equals its phone, in any format', async () => {
				const ws = await freshWorkspace()
				await seedContact(ws.id, 'voice_queued', listed('+4520123456'))
				await seedContact(ws.id, 'voice_queued', {
					phone: '0045 20-12-34-56',
					...listed('+4520123456'),
				})
				await seedContact(ws.id, 'voice_queued', { phone: '20 12 34 56', ...listed('+4520123456') })
				expect(await readIds(ws.id)).toEqual([])
			})

			it('reads the contact again once its phone is edited to another number', async () => {
				const ws = await freshWorkspace()
				const c = await seedContact(ws.id, 'voice_queued', {
					phone: '+4520999999',
					...listed('+4520123456'),
				})
				expect(await readIds(ws.id)).toEqual([c?.id])
			})

			it('reads the contact again once dnc_refusal is cleared', async () => {
				const ws = await freshWorkspace()
				const c = await seedContact(ws.id, 'voice_queued', listed('+4520123456'))
				expect(await readIds(ws.id)).toEqual([])
				await db
					.update(objects)
					.set({ metadata: sql`${objects.metadata} - 'dnc_refusal'` })
					.where(eq(objects.id, c?.id ?? ''))
				expect(await readIds(ws.id)).toEqual([c?.id])
			})

			it('is stamped by the tick, skipped afterwards, and stamped again for a new listed number', async () => {
				const ws = await freshWorkspace()
				const c = await seedContact(ws.id, 'voice_queued')
				const { d, createCall } = deps(ws.id)
				d.gate.robinson = { has: () => true }

				await runDialerTick(ws.id, d)
				const [stamped] = await db
					.select({ metadata: objects.metadata })
					.from(objects)
					.where(eq(objects.id, c?.id ?? ''))
				expect(stamped?.metadata).toMatchObject({
					dnc_refusal: { check: 'robinson', phone: '+4520123456' },
				})
				expect(await readIds(ws.id)).toEqual([])

				await db
					.update(objects)
					.set({ metadata: sql`${objects.metadata} || '{"phone":"+4520777777"}'::jsonb` })
					.where(eq(objects.id, c?.id ?? ''))
				expect(await readIds(ws.id)).toEqual([c?.id])
				await runDialerTick(ws.id, d)
				const [restamped] = await db
					.select({ metadata: objects.metadata })
					.from(objects)
					.where(eq(objects.id, c?.id ?? ''))
				expect(restamped?.metadata).toMatchObject({ dnc_refusal: { phone: '+4520777777' } })
				expect(await readIds(ws.id)).toEqual([])
				expect(createCall).not.toHaveBeenCalled()
			})
		})

		it('reads a stamped contact whose refusal was transient, such as an unavailable Robinson list', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', {
				dnc_refusal: { check: 'robinson', reason: 'Robinson list is unavailable', at: DUE },
			})
			expect(await readIds(ws.id)).toEqual([c?.id])
		})

		it('treats an owner as unmapped only while the founder map is usable', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', { owner: 'rune', ...STAMP })
			expect(await readIds(ws.id)).toEqual([])
			expect(await readIds(ws.id, { founderSlugs: null })).toEqual([c?.id])
			expect(await readIds(ws.id, { founderSlugs: ['sebk', 'rune'] })).toEqual([c?.id])
		})

		it('dials the one dialable contact behind 60 stamped, permanently refused ones', async () => {
			const ws = await freshWorkspace()
			const causes: Record<string, unknown>[] = [
				{ approval_hold: true },
				{ phone: undefined },
				{ owner: 'rune' },
				{ protect: true },
				{ role: 'investor' },
				{ dial_attempt_n: 3 },
				{
					dnc_refusal: {
						check: 'robinson',
						reason: 'number is on the Robinson list',
						at: DUE,
						phone: '+4520123456',
					},
				},
			]
			for (let i = 0; i < 60; i++) {
				const at = new Date(Date.parse('2026-10-01T06:00:00Z') + i * 1000).toISOString()
				await seedContact(ws.id, 'voice_queued', {
					...STAMP,
					...causes[i % causes.length],
					next_dial_at: at,
				})
			}
			const dialable = await seedContact(ws.id, 'voice_queued', { next_dial_at: DUE })
			const { d, createCall } = deps(ws.id)

			const result = await runDialerTick(ws.id, d)

			expect(result).toMatchObject({ dialed_count: 1, refused_count: 0 })
			const sent = createCall.mock.calls[0]?.[0] as unknown as {
				clientState: { contact_id: string }
			}
			expect(sent.clientState.contact_id).toBe(dialable?.id)
			expect(await statusOf(dialable?.id ?? '')).toBe('voice_dialing')
		})

		it('works through a head of unstamped refused contacts over a few ticks, then dials', async () => {
			const ws = await freshWorkspace()
			for (let i = 0; i < 60; i++) {
				const at = new Date(Date.parse('2026-10-01T06:00:00Z') + i * 1000).toISOString()
				await seedContact(ws.id, 'voice_queued', { approval_hold: true, next_dial_at: at })
			}
			const dialable = await seedContact(ws.id, 'voice_queued', { next_dial_at: DUE })
			const { d, createCall } = deps(ws.id)

			await runDialerTick(ws.id, d)
			expect(createCall).not.toHaveBeenCalled()
			await runDialerTick(ws.id, d)

			expect(createCall).toHaveBeenCalledTimes(1)
			expect(await statusOf(dialable?.id ?? '')).toBe('voice_dialing')
		})

		it('never treats time of day as permanent: a contact met outside the window is dialed in the next tick', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const outside = deps(ws.id, { now: () => new Date('2026-10-01T15:30:00Z') })
			const early = await runDialerTick(ws.id, outside.d)
			expect(early.skipped_reason).toBe('outside_dial_window')
			expect(outside.createCall).not.toHaveBeenCalled()
			const [row] = await db
				.select({ metadata: objects.metadata })
				.from(objects)
				.where(eq(objects.id, c?.id ?? ''))
			expect(row?.metadata).not.toHaveProperty('dnc_refusal')

			const inside = deps(ws.id)
			const result = await runDialerTick(ws.id, inside.d)
			expect(result.dialed_count).toBe(1)
			expect(await statusOf(c?.id ?? '')).toBe('voice_dialing')
		})

		it('does not exclude a contact stamped with a time_of_day refusal', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', {
				dnc_refusal: { check: 'time_of_day', reason: 'outside the window', at: DUE },
			})
			expect(await readIds(ws.id)).toEqual([c?.id])
		})

		it.each([
			['a valid +45 number is added', { phone: '+4520123456' }],
			['the hold is cleared', { approval_hold: false }],
			['the owner is mapped to a founder', { owner: 'sebk' }],
		])('dials a stamped contact once %s', async (_n, fix) => {
			const ws = await freshWorkspace()
			const base =
				_n === 'a valid +45 number is added'
					? { phone: undefined }
					: _n === 'the hold is cleared'
						? { approval_hold: true }
						: { owner: 'rune' }
			const c = await seedContact(ws.id, 'voice_queued', { ...base, ...STAMP })
			const { d, createCall } = deps(ws.id)

			await runDialerTick(ws.id, d)
			expect(createCall).not.toHaveBeenCalled()

			await db
				.update(objects)
				.set({ metadata: sql`${objects.metadata} || ${JSON.stringify(fix)}::jsonb` })
				.where(eq(objects.id, c?.id ?? ''))
			const result = await runDialerTick(ws.id, d)

			expect(result.dialed_count).toBe(1)
			expect(await statusOf(c?.id ?? '')).toBe('voice_dialing')
		})

		it('leaves an excluded contact on its status with no new status change or refusal event', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', { approval_hold: true })
			const { d } = deps(ws.id)
			await runDialerTick(ws.id, d)
			await runDialerTick(ws.id, d)
			await runDialerTick(ws.id, d)

			expect(await statusOf(c?.id ?? '')).toBe('voice_queued')
			const own = await db
				.select()
				.from(events)
				.where(eq(events.entityId, c?.id ?? ''))
			expect(own.map((e) => e.action)).toEqual(['dnc_refused'])
		})
	})

	describe('claim', () => {
		it('moves the contact to voice_dialing once and writes an audit event', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const { store } = deps(ws.id)
			const [read] = await store.readQueue(ws.id, NOW, 5, EXCLUSION)
			if (!read) throw new Error('queue empty')

			expect(await store.claim(ws.id, read, getTestActorId(), NOW)).toBe(true)
			expect(await store.claim(ws.id, read, getTestActorId(), NOW)).toBe(false)
			expect(await statusOf(c?.id ?? '')).toBe('voice_dialing')
			const audit = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, c?.id ?? ''), eq(events.action, 'status_changed')))
			expect(audit).toHaveLength(1)
		})

		it('affects zero rows when the contact changed after the tick read it', async () => {
			const ws = await freshWorkspace()
			const retry = await seedContact(ws.id, 'voice_no_answer', { next_dial_at: DUE })
			const { store } = deps(ws.id)
			const [read] = await store.readQueue(ws.id, NOW, 5, EXCLUSION)
			if (!read) throw new Error('queue empty')
			// Another writer reschedules the contact between the read and the claim.
			await db
				.update(objects)
				.set({ metadata: { owner: 'sebk', phone: '+4520123456', next_dial_at: LATER } })
				.where(eq(objects.id, retry?.id ?? ''))
			expect(await store.claim(ws.id, read, getTestActorId(), NOW)).toBe(false)
			expect(await statusOf(retry?.id ?? '')).toBe('voice_no_answer')
		})
	})

	describe('dial attempt count', () => {
		it('the claim writes dial_attempt_n = n + 1 and the later call.initiated leaves n + 1, not n + 2', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_no_answer', {
				next_dial_at: DUE,
				dial_attempt_n: 1,
			})
			const { d, createCall } = deps(ws.id)

			await runDialerTick(ws.id, d)

			const sent = createCall.mock.calls[0]?.[0] as unknown as {
				clientState: { dial_attempt_n: number }
			}
			expect(sent.clientState.dial_attempt_n).toBe(2)
			// Written at claim time, before any webhook: a lost call.initiated cannot hide this dial.
			expect(await attemptsOf(c?.id ?? '')).toBe(2)

			await applyVoiceEvent(db, {
				workspaceId: ws.id,
				contactId: c?.id ?? '',
				event: { type: 'call_initiated', callId: 'call-n', dialAttemptN: 2, to: '+4520123456' },
				now: NOW,
			})
			expect(await attemptsOf(c?.id ?? '')).toBe(2)
		})

		it('starts a first dial at 1 when the contact has no count yet', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const { d } = deps(ws.id)
			await runDialerTick(ws.id, d)
			expect(await attemptsOf(c?.id ?? '')).toBe(1)
		})
	})

	describe('concurrent ticks', () => {
		it('place one call per contact when two ticks race over a voice_queued contact and a due retry contact', async () => {
			const ws = await freshWorkspace()
			const queued = await seedContact(ws.id, 'voice_queued')
			const retry = await seedContact(ws.id, 'voice_no_answer', {
				next_dial_at: DUE,
				dial_attempt_n: 1,
			})
			const { d, createCall } = deps(ws.id)

			const results = await Promise.all([runDialerTick(ws.id, d), runDialerTick(ws.id, d)])

			expect(createCall).toHaveBeenCalledTimes(2)
			const dialed = createCall.mock.calls.map(
				(call) =>
					(call[0] as unknown as { clientState: { contact_id: string } }).clientState.contact_id,
			)
			expect(dialed.sort()).toEqual([queued?.id, retry?.id].sort())
			expect(results[0].dialed_count + results[1].dialed_count).toBe(2)
			expect(await statusOf(queued?.id ?? '')).toBe('voice_dialing')
			expect(await statusOf(retry?.id ?? '')).toBe('voice_dialing')
			const initiated = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, ws.id), eq(events.action, 'call_initiated')))
			expect(initiated).toHaveLength(2)
		})

		it('a third tick after the claim places nothing', async () => {
			const ws = await freshWorkspace()
			await seedContact(ws.id, 'voice_no_answer', { next_dial_at: DUE })
			const { d, createCall } = deps(ws.id)
			await runDialerTick(ws.id, d)
			await runDialerTick(ws.id, d)
			expect(createCall).toHaveBeenCalledTimes(1)
		})
	})

	describe('pacing counts', () => {
		it('counts call_initiated events by action in the rolling minute and since Copenhagen midnight', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_declined')
			const actorId = getTestActorId()
			const at = (iso: string) => new Date(iso)
			const row = (createdAt: Date, action = 'call_initiated') => ({
				workspaceId: ws.id,
				actorId,
				action,
				entityType: 'object',
				entityId: c?.id ?? '',
				createdAt,
			})
			await db.insert(events).values([
				row(at('2026-10-01T08:59:30Z')), // 30s ago
				row(at('2026-10-01T08:58:00Z')), // 2 min ago, today
				row(at('2026-09-30T21:59:00Z')), // before Copenhagen midnight
				row(at('2026-10-01T08:59:50Z'), 'dialer_tick'), // wrong action
			])
			const { store } = deps(ws.id)
			expect(await store.countCallInitiated(ws.id, new Date(NOW.getTime() - 60_000))).toBe(1)
			expect(await store.countCallInitiated(ws.id, new Date('2026-09-30T22:00:00Z'))).toBe(2)
		})

		it('stops dialing at the rate cap using the stored events', async () => {
			const ws = await freshWorkspace()
			const contacts = await Promise.all([1, 2, 3].map(() => seedContact(ws.id, 'voice_queued')))
			await db.insert(events).values(
				[1, 2].map(() => ({
					workspaceId: ws.id,
					actorId: getTestActorId(),
					action: 'call_initiated',
					entityType: 'object',
					entityId: contacts[0]?.id ?? '',
					createdAt: new Date('2026-10-01T08:59:30Z'),
				})),
			)
			const { d, createCall } = deps(ws.id, { config: { ...CONFIG, rateLimitPerMinute: 3 } })
			const result = await runDialerTick(ws.id, d)
			expect(result).toMatchObject({ in_last_60s: 2, dialed_count: 1 })
			expect(createCall).toHaveBeenCalledTimes(1)
		})
	})

	describe('Telnyx failure through the real reducer', () => {
		it('ends the contact on voice_failed and writes the Attention 5 dead letter', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const { d, createCall } = deps(ws.id)
			createCall.mockRejectedValue(
				new Error('Telnyx POST /v2/calls failed after 3 attempts: HTTP 503'),
			)

			const result = await runDialerTick(ws.id, d)

			expect(result.dialed_count).toBe(0)
			expect(await statusOf(c?.id ?? '')).toBe('voice_failed')
			const [meta] = await db
				.select({ metadata: objects.metadata })
				.from(objects)
				.where(eq(objects.id, c?.id ?? ''))
			expect(meta?.metadata).toMatchObject({ voice_end_reason: 'telnyx_rest_failure' })
			expect(meta?.metadata).not.toHaveProperty('next_dial_at')
			const deadLetters = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, c?.id ?? ''), eq(events.action, 'voice_dead_letter')))
			expect(deadLetters).toHaveLength(1)
			expect(deadLetters[0]?.data).toMatchObject({ attention: 5, channel: '#sales' })
		})
	})

	describe('refusal stamp', () => {
		it('merges into metadata without touching status or other keys', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued', { keep: 'me' })
			const { store } = deps(ws.id)
			await store.stampMetadata(ws.id, c?.id ?? '', {
				robinson_listed_at: '2026-10-01T09:00:00.000Z',
			})
			const [row] = await db
				.select()
				.from(objects)
				.where(eq(objects.id, c?.id ?? ''))
			expect(row?.status).toBe('voice_queued')
			expect(row?.metadata).toMatchObject({
				keep: 'me',
				owner: 'sebk',
				robinson_listed_at: '2026-10-01T09:00:00.000Z',
			})
		})
	})

	describe('real Telnyx client against a stub REST server', () => {
		interface Seen {
			url: string
			headers: Record<string, string | string[] | undefined>
			body: Record<string, unknown>
		}
		let server: Server
		let seen: Seen[] = []
		let respondWith: (n: number) => { status: number; body: unknown } = () => ({
			status: 200,
			body: { data: { call_control_id: 'stub-call-1', call_session_id: 'stub-session-1' } },
		})

		beforeAll(async () => {
			server = createServer((req, res) => {
				let raw = ''
				req.on('data', (c) => {
					raw += c
				})
				req.on('end', () => {
					seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} })
					const r = respondWith(seen.length)
					res.statusCode = r.status
					res.setHeader('Content-Type', 'application/json')
					res.end(JSON.stringify(r.body))
				})
			})
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		})
		afterAll(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		})
		beforeEach(() => {
			seen = []
		})

		function realClientDeps(workspaceId: string) {
			const port = (server.address() as AddressInfo).port
			const telnyx = createTelnyxClient({
				apiKey: 'stub-key',
				baseUrl: `http://127.0.0.1:${port}`,
				sleep: async () => {},
			})
			return deps(workspaceId, { telnyx })
		}

		it('sends the contact id as base64 client_state, with premium AMD and an idempotency key', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const { d } = realClientDeps(ws.id)

			const result = await runDialerTick(ws.id, d)

			expect(result.dialed_count).toBe(1)
			expect(seen).toHaveLength(1)
			const req = seen[0] as Seen
			expect(req.url).toBe('/v2/calls')
			expect(req.headers['idempotency-key']).toBe(`${c?.id}:1`)
			expect(req.body).toMatchObject({
				to: '+4520123456',
				from: '+4570000000',
				assistant_id: 'assistant-1',
				connection_id: 'app-1',
				answering_machine_detection: 'premium',
			})
			expect(req.body).not.toHaveProperty('metadata')
			expect(decodeClientState(req.body.client_state as string)).toEqual({
				contact_id: c?.id,
				workspace_id: ws.id,
				dial_attempt_n: 1,
			})
		})

		it('retries a 5xx 3 times, then dead-letters at Attention 5 and the contact ends voice_failed', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			respondWith = () => ({ status: 503, body: { errors: [{ title: 'unavailable' }] } })
			const { d } = realClientDeps(ws.id)

			try {
				const result = await runDialerTick(ws.id, d)
				expect(result.dialed_count).toBe(0)
			} finally {
				respondWith = () => ({
					status: 200,
					body: { data: { call_control_id: 'stub-call-1', call_session_id: 'stub-session-1' } },
				})
			}

			expect(seen).toHaveLength(3)
			expect(await statusOf(c?.id ?? '')).toBe('voice_failed')
			const deadLetters = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, c?.id ?? ''), eq(events.action, 'voice_dead_letter')))
			expect(deadLetters).toHaveLength(1)
			expect(deadLetters[0]?.data).toMatchObject({ attention: 5, channel: '#sales' })
			expect(String((deadLetters[0]?.data as { reason: string }).reason)).toContain('503')
		})

		it('does not retry a 4xx and still ends the contact on voice_failed', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			respondWith = () => ({ status: 422, body: { errors: [{ title: 'invalid number' }] } })
			const { d } = realClientDeps(ws.id)
			try {
				await runDialerTick(ws.id, d)
			} finally {
				respondWith = () => ({
					status: 200,
					body: { data: { call_control_id: 'stub-call-1', call_session_id: 'stub-session-1' } },
				})
			}
			expect(seen).toHaveLength(1)
			expect(await statusOf(c?.id ?? '')).toBe('voice_failed')
		})
	})

	describe('AMD machine result on a call the dialer placed', () => {
		it('routes to voice_voicemail with a forced hangup and the voicemail SMS', async () => {
			const ws = await freshWorkspace()
			const c = await seedContact(ws.id, 'voice_queued')
			const { d } = deps(ws.id)
			await runDialerTick(ws.id, d)
			expect(await statusOf(c?.id ?? '')).toBe('voice_dialing')

			const calls: string[] = []
			const runner: EffectRunner = {
				sendSms: async (mode) => {
					calls.push(`sms:${mode}`)
				},
				hangupCall: async (callId) => {
					calls.push(`hangup:${callId}`)
				},
				deadLetter: async () => {
					calls.push('dead_letter')
				},
			}
			// What the webhook does with call.initiated, then the AMD verdict.
			await applyVoiceEvent(db, {
				workspaceId: ws.id,
				contactId: c?.id ?? '',
				event: { type: 'call_initiated', callId: 'call-amd', dialAttemptN: 1, to: '+4520123456' },
				now: NOW,
			})
			const machine = await applyVoiceEvent(db, {
				workspaceId: ws.id,
				contactId: c?.id ?? '',
				event: {
					type: 'machine_detection',
					callId: 'call-amd',
					result: 'machine',
					to: '+4520123456',
				},
				now: NOW,
			})
			if (!machine.found) throw new Error('contact not found')
			await runAppliedEffects(machine, runner)

			expect(await statusOf(c?.id ?? '')).toBe('voice_voicemail')
			expect(calls).toEqual(['hangup:call-amd', 'sms:voicemail_followup'])
		})
	})
})

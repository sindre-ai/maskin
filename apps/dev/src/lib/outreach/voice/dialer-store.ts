import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { type SQL, and, count, eq, gte, inArray, not, or, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { applyVoiceEvent, runAppliedEffects } from './apply'
import { RETRY_STATUSES, dialAttemptOf } from './dialer'
import type { DialerStore, QueueExclusion, QueuedContact } from './dialer'
import { MAX_DIALS_PER_CONTACT, PROTECT_TAGS } from './dnc-gate'
import { type EffectRunner, createDefaultEffectRunner } from './effects'

const nextDialAt = sql`(${objects.metadata}->>'next_dial_at')::timestamptz`

/**
 * The due-queue predicate, one workspace or (null) every workspace. Served by
 * objects_ws_type_status_idx: an IN list on status, no new index.
 */
function dueQueue(workspaceId: string | null, now: Date) {
	const nowIso = now.toISOString()
	return and(
		workspaceId === null ? undefined : eq(objects.workspaceId, workspaceId),
		eq(objects.type, 'contact'),
		or(
			and(
				eq(objects.status, 'voice_queued'),
				or(sql`${nextDialAt} is null`, sql`${nextDialAt} <= ${nowIso}::timestamptz`),
			),
			and(
				inArray(objects.status, [...RETRY_STATUSES]),
				sql`${nextDialAt} is not null`,
				sql`${nextDialAt} <= ${nowIso}::timestamptz`,
			),
		),
	)
}

// Whitespace as the gate's JS regex and trim() see it. The SQL strips a superset, so a value the
// gate accepts is never read as invalid here; the reverse only means a contact is read once more.
const WS = '[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const meta = sql`${objects.metadata}`
const field = (name: string) => sql`(${meta}->${sql.raw(`'${name}'`)})`
const isString = (name: string) => sql`jsonb_typeof(${field(name)}) = 'string'`
const stringOf = (name: string) => sql`(${field(name)} #>> '{}')`
const trimmed = (text: SQL) =>
	sql`regexp_replace(${text}, ${sql.raw(`'^[${WS}]+|[${WS}]+$'`)}, '', 'g')`
/** The gate's isSet: anything but unset, null, false or an empty string. */
const isSet = (name: string) =>
	sql`coalesce(${field(name)}, 'null'::jsonb) not in ('null'::jsonb, 'false'::jsonb, '""'::jsonb)`
/** The gate's isTrue: true, or a string that trims to true in any case. */
const isTrue = (name: string) =>
	sql`coalesce(${field(name)} = 'true'::jsonb or (${isString(name)} and lower(${trimmed(stringOf(name))}) = 'true'), false)`

/**
 * True when the contact carries a stamped dnc_refusal AND a permanent cause still holds in its
 * live metadata. The stamp alone is never enough: a check name also covers transient refusals
 * (Robinson list unavailable, founder lookup failed), and a cause that was cleared (hold lifted,
 * phone added) must put the contact back on the queue. Each cause below mirrors the gate check
 * named beside it in dnc-gate.ts and is checked against it in voice-dialer.test.ts. Time of day
 * (check 5) is never stamped and has no clause here. Status (check 2) cannot occur: the queue
 * only holds voice_queued and the retry statuses. Robinson-listed has no live cause in metadata,
 * so the dialer stamps the matched number as dnc_refusal.phone (only on a confirmed match) and the
 * read excludes while that still equals the contact's normalized phone: an edited number re-admits
 * it, and clearing dnc_refusal does too. Every clause is null-safe, so the predicate is never null.
 */
function permanentlyRefused(exclusion: QueueExclusion) {
	const tags = PROTECT_TAGS.join('|')
	const tagPattern = `[[:space:]]*(${tags})[[:space:]]*`
	const digits = sql`regexp_replace(${stringOf('phone')}, ${sql.raw(`'[${WS}\\-().]'`)}, '', 'g')`
	// normalizeDanishNumber in SQL: +45XXXXXXXX, or null when the value is not a Danish number.
	const phone = sql`(case when ${isString('phone')} then case
		when ${digits} ~ '^0045' then case when ${digits} ~ '^0045[0-9]{8}$' then '+' || substr(${digits}, 3) end
		when ${digits} ~ '^[0-9]{8}$' then '+45' || ${digits}
		when ${digits} ~ '^\\+45[0-9]{8}$' then ${digits}
	end end)`
	const owner = sql`lower(${trimmed(stringOf('owner'))})`
	const slugs = exclusion.founderSlugs
	return sql`coalesce(${field('dnc_refusal')} is not null and (
		${isSet('approval_hold')} or ${isSet('held_reason')}
		or ${isTrue('protect')} or ${isTrue('protected')}
		or jsonb_path_exists(${meta}, ${`$.tags[*] ? (@ like_regex "^${tagPattern}$" flag "i")`}::jsonpath)
		or coalesce(${isString('tags')} and ${stringOf('tags')} ~* ${`(^|,)${tagPattern}(,|$)`}, false)
		or coalesce(${field('role')} = '"investor"'::jsonb, false)
		or coalesce(${field('lead_source')} = '"investor_pipeline"'::jsonb, false)
		or coalesce(case when jsonb_typeof(${field('dial_attempt_n')}) = 'number'
			then (${field('dial_attempt_n')} #>> '{}')::numeric end >= ${MAX_DIALS_PER_CONTACT}::numeric, false)
		or ${phone} is null
		or coalesce((${field('dnc_refusal')} ->> 'phone') = ${phone}, false)
		or coalesce(not (${isString('owner')}), true) or ${owner} = ''
		${
			slugs
				? sql`or ${owner} not in (${sql.join(
						slugs.map((s) => sql`${s}`),
						sql`, `,
					)})`
				: sql``
		}
	), false)`
}

/** Workspaces with at least one due contact. An idle workspace gets no tick and no tick event. */
export async function findWorkspacesWithDueContacts(db: Database, now: Date): Promise<string[]> {
	const rows = await db
		.selectDistinct({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(dueQueue(null, now))
	return rows.map((r) => r.workspaceId)
}

export function createDrizzleDialerStore(
	db: Database,
	runner: EffectRunner = createDefaultEffectRunner(db),
): DialerStore {
	return {
		async readQueue(workspaceId, now, limit, exclusion) {
			const rows = await db
				.select({
					id: objects.id,
					status: objects.status,
					metadata: objects.metadata,
					nextDialAt: sql<string | null>`${objects.metadata}->>'next_dial_at'`,
				})
				.from(objects)
				.where(and(dueQueue(workspaceId, now), not(permanentlyRefused(exclusion))))
				.orderBy(sql`coalesce(${nextDialAt}, ${objects.createdAt}) asc`)
				.limit(limit)
			return rows.map(
				(r): QueuedContact => ({
					id: r.id,
					status: r.status,
					metadata: (r.metadata ?? null) as Record<string, unknown> | null,
					nextDialAt: r.nextDialAt,
				}),
			)
		},

		async claim(workspaceId, contact, actorId, now) {
			return db.transaction(async (tx) => {
				const claimed = await tx
					.update(objects)
					// dial_attempt_n is written here, in the same update as the status, so the three-dial
					// backstop counts a placed call even if call.initiated never arrives. client_state carries
					// the same value and the reducer sets the absolute number from it, so nothing double counts.
					.set({
						status: 'voice_dialing',
						updatedAt: now,
						metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify({ dial_attempt_n: dialAttemptOf(contact) })}::jsonb`,
					})
					.where(
						and(
							eq(objects.id, contact.id),
							eq(objects.workspaceId, workspaceId),
							eq(objects.type, 'contact'),
							eq(objects.status, contact.status),
							sql`(${objects.metadata}->>'next_dial_at') is not distinct from ${contact.nextDialAt}::text`,
						),
					)
					.returning({ id: objects.id })
				if (claimed.length === 0) return false
				await recordEvent(tx, {
					workspaceId,
					actorId,
					action: 'status_changed',
					entityType: 'object',
					entityId: contact.id,
					data: {
						source: 'voice_dialer_claim',
						fromStatus: contact.status,
						toStatus: 'voice_dialing',
					},
				})
				return true
			})
		},

		async countCallInitiated(workspaceId, since) {
			const [row] = await db
				.select({ n: count() })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.action, 'call_initiated'),
						gte(events.createdAt, since),
					),
				)
			return row?.n ?? 0
		},

		async recordEvent(event) {
			await recordEvent(db, event)
		},

		async stampMetadata(workspaceId, contactId, patch) {
			// One statement, so it cannot interleave with the reducer's own metadata write.
			await db
				.update(objects)
				.set({
					metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
				})
				.where(
					and(
						eq(objects.id, contactId),
						eq(objects.workspaceId, workspaceId),
						eq(objects.type, 'contact'),
					),
				)
		},

		async failContact(workspaceId, contactId, reason) {
			const applied = await applyVoiceEvent(db, {
				workspaceId,
				contactId,
				event: { type: 'rest_failure', reason },
			})
			if (applied.found && applied.applied) await runAppliedEffects(applied, runner)
		},
	}
}

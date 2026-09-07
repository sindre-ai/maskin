import { triggers } from '@maskin/db/schema'
import { and, eq, or, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { removeTriggerMetadataKey, setTriggerMetadataKey } from '../../lib/trigger-metadata'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Real-Postgres coverage for the two Slack-setup behaviours that mocked
 * `db.select` / `db.update` cannot verify:
 *
 *   1. The single-statement jsonb merges in `lib/trigger-metadata.ts` — three
 *      writers (`runSlackTriggerSetup` → `slack_setup`,
 *      `handleMemberLeftChannel` → `auto_paused`, and the `clear_auto_paused`
 *      branch of `PATCH /api/triggers/:id`) each own one key and must preserve
 *      the others'. A mock only records the argument; whether `||` and `-`
 *      actually behave that way is a Postgres semantic.
 *
 *   2. The `@>` containment predicate `handleMemberLeftChannel` uses to find
 *      the triggers listening on a kicked channel. The unit test mocks
 *      `db.select` wholesale, so the predicate string is never executed — if
 *      containment did not match the picker's persisted config shape,
 *      auto-pause would match zero triggers and the feature would be silently
 *      inert with no error anywhere.
 */

const SLACK_SETUP = {
	channel_ids: ['C_ALPHA'],
	join_attempts: [
		{ channel_id: 'C_ALPHA', status: 'joined', attempted_at: '2026-09-01T10:00:00.000Z' },
	],
	confirmation_posted_at: { C_ALPHA: '2026-09-01T10:00:01.000Z' },
	last_setup_at: '2026-09-01T10:00:01.000Z',
}

const AUTO_PAUSED = {
	reason: 'slack_member_left',
	channel_id: 'C_ALPHA',
	paused_at: '2026-09-01T12:00:00.000Z',
	previous_enabled: true,
}

/** The shape the channel picker persists for a Slack channel-message trigger. */
function slackTriggerConfig(field: string, channelIds: string[]) {
	return {
		event_type: 'slack.message.created',
		conditions: [{ field, operator: 'in', value: channelIds }],
	}
}

async function readMetadata(triggerId: string): Promise<Record<string, unknown> | null> {
	const [row] = await db
		.select({ metadata: triggers.metadata })
		.from(triggers)
		.where(eq(triggers.id, triggerId))
		.limit(1)
	return (row?.metadata as Record<string, unknown> | null) ?? null
}

/** The exact predicate from `handleMemberLeftChannel` section (c). */
async function findTriggersListeningOn(workspaceId: string, channelId: string) {
	const containsChannel = JSON.stringify([
		{ field: 'event.channel', operator: 'in', value: [channelId] },
	])
	const containsItemChannel = JSON.stringify([
		{ field: 'event.item.channel', operator: 'in', value: [channelId] },
	])
	return db
		.select({ id: triggers.id })
		.from(triggers)
		.where(
			and(
				eq(triggers.workspaceId, workspaceId),
				or(
					sql`${triggers.config}->'conditions' @> ${containsChannel}::jsonb`,
					sql`${triggers.config}->'conditions' @> ${containsItemChannel}::jsonb`,
				),
			),
		)
}

describe('Slack trigger metadata (real Postgres)', () => {
	let workspaceId: string
	let actorId: string
	let agentId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
	})

	describe('single-key jsonb merges', () => {
		it('setTriggerMetadataKey adds a key without clobbering a sibling written between read and write', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, { metadata: null })

			// Writer A stamps `slack_setup` on a null metadata column.
			await db
				.update(triggers)
				.set({ metadata: setTriggerMetadataKey('slack_setup', SLACK_SETUP) })
				.where(eq(triggers.id, trigger.id))
			expect(await readMetadata(trigger.id)).toEqual({ slack_setup: SLACK_SETUP })

			// Writer B stamps `auto_paused`. This is the interleaving that broke
			// before: a JS read-modify-write in either writer would drop the
			// other's key, leaving the trigger disabled with no banner.
			await db
				.update(triggers)
				.set({ enabled: false, metadata: setTriggerMetadataKey('auto_paused', AUTO_PAUSED) })
				.where(eq(triggers.id, trigger.id))
			expect(await readMetadata(trigger.id)).toEqual({
				slack_setup: SLACK_SETUP,
				auto_paused: AUTO_PAUSED,
			})
		})

		it('setTriggerMetadataKey overwrites its own key in place, leaving siblings untouched', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, {
				metadata: { slack_setup: SLACK_SETUP, auto_paused: AUTO_PAUSED },
			})

			const rerun = { ...SLACK_SETUP, last_setup_at: '2026-09-02T09:00:00.000Z' }
			await db
				.update(triggers)
				.set({ metadata: setTriggerMetadataKey('slack_setup', rerun) })
				.where(eq(triggers.id, trigger.id))

			expect(await readMetadata(trigger.id)).toEqual({
				slack_setup: rerun,
				auto_paused: AUTO_PAUSED,
			})
		})

		it('removeTriggerMetadataKey drops auto_paused and keeps slack_setup — the Resume path', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, {
				enabled: false,
				metadata: { slack_setup: SLACK_SETUP, auto_paused: AUTO_PAUSED },
			})

			await db
				.update(triggers)
				.set({ enabled: true, metadata: removeTriggerMetadataKey('auto_paused') })
				.where(eq(triggers.id, trigger.id))

			const md = await readMetadata(trigger.id)
			// Removal, not just absence of an update: a stale `auto_paused` would
			// keep the red banner rendering after the trigger is re-enabled.
			expect(md).not.toHaveProperty('auto_paused')
			expect(md).toEqual({ slack_setup: SLACK_SETUP })
		})

		it('removeTriggerMetadataKey is a no-op on a trigger that was never auto-paused', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, { metadata: null })

			await db
				.update(triggers)
				.set({ metadata: removeTriggerMetadataKey('auto_paused') })
				.where(eq(triggers.id, trigger.id))

			// `coalesce(metadata,'{}')` means a null column normalises to `{}`
			// rather than erroring — the PATCH handler fires this branch whenever
			// `clear_auto_paused` is set, regardless of prior state.
			expect(await readMetadata(trigger.id)).toEqual({})
		})
	})

	describe('auto-pause channel containment query', () => {
		it('matches a trigger whose picker config lists the kicked channel among several', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, {
				type: 'event',
				config: slackTriggerConfig('event.channel', ['C_OTHER', 'C_ALPHA', 'C_THIRD']),
			})

			const matched = await findTriggersListeningOn(workspaceId, 'C_ALPHA')
			expect(matched.map((r) => r.id)).toEqual([trigger.id])
		})

		it('matches the event.item.channel shape used by reaction/member triggers', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, {
				type: 'event',
				config: slackTriggerConfig('event.item.channel', ['C_ALPHA']),
			})

			const matched = await findTriggersListeningOn(workspaceId, 'C_ALPHA')
			expect(matched.map((r) => r.id)).toEqual([trigger.id])
		})

		it('does not match a trigger listening on a different channel', async () => {
			await insertTrigger(db, workspaceId, actorId, agentId, {
				type: 'event',
				config: slackTriggerConfig('event.channel', ['C_SOMEWHERE_ELSE']),
			})

			expect(await findTriggersListeningOn(workspaceId, 'C_ALPHA')).toEqual([])
		})

		it('does not match a trigger in another workspace listening on the same channel', async () => {
			const otherWs = await insertWorkspace(db, actorId)
			await insertTrigger(db, otherWs.id, actorId, agentId, {
				type: 'event',
				config: slackTriggerConfig('event.channel', ['C_ALPHA']),
			})

			expect(await findTriggersListeningOn(workspaceId, 'C_ALPHA')).toEqual([])
		})

		it('does not match a cron trigger with no conditions array', async () => {
			await insertTrigger(db, workspaceId, actorId, agentId, {
				type: 'cron',
				config: { schedule: '0 9 * * *' },
			})

			expect(await findTriggersListeningOn(workspaceId, 'C_ALPHA')).toEqual([])
		})
	})
})

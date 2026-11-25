import { integrations } from '@maskin/db/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { hasSiblingYoutubeGrant } from '../../lib/integrations/providers/youtube/sibling'
import { buildIntegration, insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

/** The sibling check decides whether a revoke is skipped, so it runs against real Postgres. */

const ACCOUNT = 'person@example.com'

describe('hasSiblingYoutubeGrant', () => {
	let actorId: string
	let workspaceId: string
	let otherWorkspaceId: string

	async function connect(
		forWorkspace: string,
		overrides: { status?: string; externalId?: string; provider?: string } = {},
	) {
		await db.insert(integrations).values(
			buildIntegration({
				workspaceId: forWorkspace,
				provider: overrides.provider ?? 'youtube',
				status: overrides.status ?? 'active',
				externalId: overrides.externalId ?? ACCOUNT,
				createdBy: actorId,
			}) as typeof integrations.$inferInsert,
		)
	}

	beforeEach(async () => {
		const actor = await insertActor(db, { type: 'agent' })
		if (!actor) throw new Error('failed to seed actor')
		actorId = actor.id
		const first = await insertWorkspace(db, actorId)
		const second = await insertWorkspace(db, actorId)
		if (!first || !second) throw new Error('failed to seed workspaces')
		workspaceId = first.id
		otherWorkspaceId = second.id
	})

	it('is true when another workspace has the same account active', async () => {
		await connect(workspaceId)
		await connect(otherWorkspaceId)
		expect(await hasSiblingYoutubeGrant(db, { workspaceId, externalId: ACCOUNT })).toBe(true)
	})

	it('is true for a pending row in another workspace', async () => {
		await connect(otherWorkspaceId, { status: 'pending' })
		expect(await hasSiblingYoutubeGrant(db, { workspaceId, externalId: ACCOUNT })).toBe(true)
	})

	it('is false when only this workspace has the account', async () => {
		await connect(workspaceId)
		expect(await hasSiblingYoutubeGrant(db, { workspaceId, externalId: ACCOUNT })).toBe(false)
	})

	it('ignores revoked rows, other accounts and other providers', async () => {
		await connect(otherWorkspaceId, { status: 'revoked' })
		await connect(otherWorkspaceId, { externalId: 'someone-else@example.com' })
		await connect(otherWorkspaceId, { provider: 'google-calendar' })
		expect(await hasSiblingYoutubeGrant(db, { workspaceId, externalId: ACCOUNT })).toBe(false)
	})
})

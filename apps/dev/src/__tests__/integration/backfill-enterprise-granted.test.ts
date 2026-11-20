import { workspaces as workspacesTable } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { backfillEnterpriseGranted } from '../../../scripts/backfill-enterprise-granted'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

describe('backfill-enterprise-granted (integration)', () => {
	async function flagOf(id: string) {
		const [row] = await db
			.select({ enterpriseGranted: workspacesTable.enterpriseGranted })
			.from(workspacesTable)
			.where(eq(workspacesTable.id, id))
		return row?.enterpriseGranted
	}

	it('flags workspaces billed to an allowlisted actor, leaves others, and is idempotent', async () => {
		const ops = await insertActor(db)
		const other = await insertActor(db)
		const opsWs = await insertWorkspace(db, ops.id, { name: 'Ops Owned', enterpriseGranted: false })
		const alreadyWs = await insertWorkspace(db, ops.id, {
			name: 'Ops Already',
			enterpriseGranted: true,
		})
		const otherWs = await insertWorkspace(db, other.id, {
			name: 'Other Owned',
			enterpriseGranted: false,
		})
		const env = { MASKIN_ENTERPRISE_ACTOR_IDS: ops.id }

		const dry = await backfillEnterpriseGranted(db, { dryRun: true, env })
		expect(dry).toEqual([{ id: opsWs.id, name: 'Ops Owned' }])
		expect(await flagOf(opsWs.id)).toBe(false)

		const changed = await backfillEnterpriseGranted(db, { env })
		expect(changed).toEqual([{ id: opsWs.id, name: 'Ops Owned' }])
		expect(await flagOf(opsWs.id)).toBe(true)
		expect(await flagOf(alreadyWs.id)).toBe(true)
		expect(await flagOf(otherWs.id)).toBe(false)

		expect(await backfillEnterpriseGranted(db, { env })).toEqual([])
	})

	it('refuses to run with an empty allowlist', async () => {
		await expect(backfillEnterpriseGranted(db, { env: {} })).rejects.toThrow(
			'MASKIN_ENTERPRISE_ACTOR_IDS is empty',
		)
	})
})

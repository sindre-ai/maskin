import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

const MIGRATION = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../../../../packages/db/drizzle/0088_crm_contact_statuses_voice_outreach.sql',
	),
	'utf8',
)

const NEW_STATUSES = [
	'voice_queued',
	'voice_dialing',
	'voice_answered',
	'voice_no_answer',
	'voice_busy',
	'voice_voicemail',
	'voice_declined',
	'voice_meeting_booked',
	'voice_warm_transferred',
	'voice_failed',
	'rejected',
	'deleted_by_request',
]

// Eight statuses from extensions/crm/shared.ts on main, plus rejected and two
// workspace-custom entries: 11 stored statuses, the shape of a live workspace.
const ORIGINALS_WITH_REJECTED = [
	'new_lead',
	'connection_requested',
	'messaged',
	'in_conversation',
	'meeting_booked',
	'converted',
	'not_interested',
	'follow_up_later',
	'rejected',
	'custom_nurture',
	'custom_partner',
]
const ORIGINALS_WITHOUT_REJECTED = ORIGINALS_WITH_REJECTED.filter((s) => s !== 'rejected')

async function runMigration() {
	await sql.unsafe(MIGRATION)
}

async function contactStatuses(workspaceId: string): Promise<unknown> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	return (row?.settings as { statuses?: { contact?: unknown } } | null)?.statuses?.contact
}

function workspaceWith(settings: Record<string, unknown>) {
	return insertWorkspace(db, getTestActorId(), { settings })
}

describe('crm voice statuses settings migration (0088)', () => {
	it('appends the missing statuses once, in order, and a second run changes nothing', async () => {
		const ws = await workspaceWith({
			enabled_modules: ['work', 'knowledge', 'crm'],
			statuses: { contact: ORIGINALS_WITH_REJECTED },
		})

		await runMigration()
		const afterFirst = await contactStatuses(ws.id)
		// rejected was already stored: not appended a second time.
		const expected = [...ORIGINALS_WITH_REJECTED, ...NEW_STATUSES.filter((s) => s !== 'rejected')]
		expect(afterFirst).toEqual(expected)

		await runMigration()
		expect(await contactStatuses(ws.id)).toEqual(afterFirst)
	})

	it('appends rejected too when the stored list does not have it, still once overall', async () => {
		const ws = await workspaceWith({
			enabled_modules: ['work', 'crm'],
			statuses: { contact: ORIGINALS_WITHOUT_REJECTED },
		})
		await runMigration()
		await runMigration()
		const list = (await contactStatuses(ws.id)) as string[]
		expect(list.slice(0, ORIGINALS_WITHOUT_REJECTED.length)).toEqual(ORIGINALS_WITHOUT_REJECTED)
		expect(list.slice(ORIGINALS_WITHOUT_REJECTED.length)).toEqual(NEW_STATUSES)
		expect(list.filter((s) => s === 'rejected')).toHaveLength(1)
		expect(new Set(list).size).toBe(list.length)
	})

	it('leaves other object types, other settings and entry order untouched', async () => {
		const ws = await workspaceWith({
			enabled_modules: ['work', 'crm'],
			statuses: { contact: ORIGINALS_WITHOUT_REJECTED, company: ['prospect', 'customer'] },
			display_names: { contact: 'Person' },
		})
		await runMigration()
		const [row] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, ws.id))
		const settings = row?.settings as {
			statuses: Record<string, string[]>
			display_names: Record<string, string>
		}
		expect(settings.statuses.company).toEqual(['prospect', 'customer'])
		expect(settings.display_names).toEqual({ contact: 'Person' })
	})

	it('skips a workspace with crm off, and one with crm on but no stored contact list', async () => {
		const crmOff = await workspaceWith({
			enabled_modules: ['work'],
			statuses: { contact: ORIGINALS_WITH_REJECTED },
		})
		const noList = await workspaceWith({
			enabled_modules: ['work', 'crm'],
			statuses: { company: ['prospect'] },
		})
		const noStatuses = await workspaceWith({ enabled_modules: ['work', 'crm'] })
		await runMigration()
		expect(await contactStatuses(crmOff.id)).toEqual(ORIGINALS_WITH_REJECTED)
		expect(await contactStatuses(noList.id)).toBeUndefined()
		expect(await contactStatuses(noStatuses.id)).toBeUndefined()
	})

	it('a status write of deleted_by_request and a voice_* status succeeds only after the migration', async () => {
		const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
		const ws = await workspaceWith({
			enabled_modules: ['work', 'knowledge', 'crm'],
			statuses: { contact: ORIGINALS_WITH_REJECTED },
		})
		const contact = await insertObject(db, ws.id, getTestActorId(), {
			type: 'contact',
			status: 'new_lead',
		})
		const patch = (status: string) =>
			app.request(
				jsonRequest('PATCH', `/api/objects/${contact.id}`, { status }, { 'x-workspace-id': ws.id }),
			)

		// The finding: without the migration an existing workspace rejects the new statuses.
		expect((await patch('deleted_by_request')).status).toBe(400)
		expect((await patch('voice_queued')).status).toBe(400)

		await runMigration()
		expect((await patch('voice_queued')).status).toBe(200)
		expect((await patch('deleted_by_request')).status).toBe(200)
		expect((await patch('rejected')).status).toBe(200)
	})
})

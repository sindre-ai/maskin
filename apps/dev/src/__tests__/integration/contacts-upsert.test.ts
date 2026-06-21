import { notifications, objects, relationships, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: contactsRoutes } = await import('../../routes/contacts')

function createApp() {
	return createIntegrationApp({ path: '/api/contacts', module: contactsRoutes })
}

async function postUpsert(
	body: { email: string; name?: string; meeting_id?: string },
	workspaceId: string,
) {
	const app = createApp()
	return app.request(
		jsonRequest('POST', '/api/contacts/upsert', body, { 'x-workspace-id': workspaceId }),
	)
}

describe('POST /api/contacts/upsert', () => {
	let workspaceId: string
	let meetingId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				display_names: {},
				statuses: { task: ['todo'] },
				field_definitions: {},
				relationship_types: ['informs', 'relates_to'],
			},
		})
		workspaceId = ws.id
		const meeting = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'meeting',
			status: 'done',
			title: 'Test meeting',
		})
		meetingId = meeting.id
	})

	it('creates a new contact, auto-enables CRM, emits a notification, and wires attended_by', async () => {
		const res = await postUpsert(
			{ email: 'Alice@Example.com', name: 'Alice', meeting_id: meetingId },
			workspaceId,
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.contact_id).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.created).toBe(true)
		expect(body.crm_auto_enabled).toBe(true)
		expect(body.notification_id).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.attended_by_relationship_id).toMatch(/^[0-9a-f-]{36}$/)

		// Contact stored with lowercased email in metadata.
		const [contact] = await db.select().from(objects).where(eq(objects.id, body.contact_id))
		expect(contact.type).toBe('contact')
		expect(contact.status).toBe('new_lead')
		expect(contact.title).toBe('Alice')
		expect((contact.metadata as Record<string, unknown>).email).toBe('alice@example.com')

		// CRM module is now in enabled_modules; attended_by is a registered relationship type.
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		const settings = ws.settings as Record<string, unknown>
		expect(settings.enabled_modules).toContain('crm')
		expect(settings.relationship_types).toContain('attended_by')

		// Notification surfaces the auto-enable per D6.
		const [notif] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, body.notification_id))
		expect(notif.type).toBe('good_news')
		expect(notif.title).toMatch(/CRM/)
		expect(notif.content).toMatch(/Enabling CRM module/)

		// meeting—attended_by→contact edge exists.
		const edges = await db
			.select()
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceId, meetingId),
					eq(relationships.targetId, body.contact_id),
					eq(relationships.type, 'attended_by'),
				),
			)
		expect(edges).toHaveLength(1)
	})

	it('matches an existing contact case-insensitively and does not duplicate', async () => {
		const first = await postUpsert(
			{ email: 'bob@example.com', name: 'Bob', meeting_id: meetingId },
			workspaceId,
		)
		expect(first.status).toBe(200)
		const firstBody = await first.json()
		expect(firstBody.created).toBe(true)

		const second = await postUpsert(
			{ email: 'BOB@EXAMPLE.COM', name: 'Robert', meeting_id: meetingId },
			workspaceId,
		)
		expect(second.status).toBe(200)
		const secondBody = await second.json()
		expect(secondBody.contact_id).toBe(firstBody.contact_id)
		expect(secondBody.created).toBe(false)
		expect(secondBody.crm_auto_enabled).toBe(false)
		expect(secondBody.notification_id).toBeNull()
		// Existing edge is reused; the relationship id is the same one created on first upsert.
		expect(secondBody.attended_by_relationship_id).toBe(firstBody.attended_by_relationship_id)

		const contacts = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'contact')))
		expect(contacts).toHaveLength(1)
		const edges = await db
			.select()
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceId, meetingId),
					eq(relationships.targetId, firstBody.contact_id),
					eq(relationships.type, 'attended_by'),
				),
			)
		expect(edges).toHaveLength(1)
	})

	it('produces N unique contacts for N unique-email attendees in one meeting', async () => {
		const inputs = [
			{ email: 'carol@example.com', name: 'Carol' },
			{ email: 'dave@example.com', name: 'Dave' },
			{ email: 'erin@example.com', name: 'Erin' },
		]
		const responses = await Promise.all(
			inputs.map((i) => postUpsert({ ...i, meeting_id: meetingId }, workspaceId)),
		)
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
		const bodies = await Promise.all(responses.map((r) => r.json()))
		const uniqueContactIds = new Set(bodies.map((b) => b.contact_id))
		expect(uniqueContactIds.size).toBe(3)
		expect(bodies.every((b) => b.created)).toBe(true)
		// CRM is only auto-enabled once across the parallel run.
		expect(bodies.filter((b) => b.crm_auto_enabled).length).toBe(1)
	})

	it('skips the notification when CRM is already enabled but still ensures attended_by is registered', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work', 'crm'],
				display_names: {},
				statuses: {},
				field_definitions: {},
				relationship_types: ['informs', 'relates_to'],
			},
		})
		const meeting = await insertObject(db, ws.id, getTestActorId(), {
			type: 'meeting',
			status: 'done',
			title: 'Already-CRM meeting',
		})
		const res = await postUpsert(
			{ email: 'frank@example.com', name: 'Frank', meeting_id: meeting.id },
			ws.id,
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.created).toBe(true)
		expect(body.crm_auto_enabled).toBe(false)
		expect(body.notification_id).toBeNull()

		const notifs = await db.select().from(notifications).where(eq(notifications.workspaceId, ws.id))
		expect(notifs).toHaveLength(0)

		const [updatedWs] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id))
		const settings = updatedWs.settings as Record<string, unknown>
		expect(settings.relationship_types).toContain('attended_by')
	})

	it('works without a meeting_id — returns null relationship id but still upserts the contact', async () => {
		const res = await postUpsert({ email: 'guy@example.com', name: 'Guy' }, workspaceId)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.contact_id).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.created).toBe(true)
		expect(body.attended_by_relationship_id).toBeNull()
	})

	it('rejects invalid email with 400', async () => {
		const res = await postUpsert({ email: 'not-an-email', name: 'X' }, workspaceId)
		expect(res.status).toBe(400)
	})

	it('returns 400 when the X-Workspace-Id header is missing', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest('POST', '/api/contacts/upsert', { email: 'a@b.com' }, {}),
		)
		expect(res.status).toBe(400)
	})
})

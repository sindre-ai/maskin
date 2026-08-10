import { beforeEach, describe, expect, it } from 'vitest'
import {
	DAILY_REGEN_CRON,
	MASKIN_APP_DATA_WINDOW_KEY,
	MASKIN_STATE_SLOT_ID,
	buildDailyRegenActionPrompt,
	dailyRegenTriggerName,
} from '../../services/mini-app-regen'
import { buildFile, buildTrigger, buildWorkspaceMember } from '../factories'
import { jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

const { default: miniAppRegenRoutes } = await import('../../routes/mini-app-regen')

const actorId = 'test-actor-id'
const workspaceId = '00000000-0000-0000-0000-000000000001'
const fileId = '11111111-1111-1111-1111-111111111111'
const targetActorId = '22222222-2222-2222-2222-222222222222'

function headers() {
	return { 'X-Workspace-Id': workspaceId }
}

describe('Mini-app regen route', () => {
	beforeEach(() => {})

	it('DoD-1 — provisions the daily regen trigger for an html app via the trigger infra', async () => {
		const { app, mockResults, calls } = createImportTestApp(miniAppRegenRoutes, '/api/mini-apps')
		const member = buildWorkspaceMember({ workspaceId, actorId })
		const htmlFile = buildFile({
			workspaceId,
			id: fileId,
			name: 'curriculum.html',
			mimeType: 'text/html',
			sizeBytes: 120,
		})
		const triggerRow = buildTrigger({
			workspaceId,
			name: dailyRegenTriggerName('Curriculum'),
			type: 'cron',
			config: { expression: DAILY_REGEN_CRON },
			targetActorId,
			createdBy: actorId,
		})
		mockResults.selectQueue = [[member], [htmlFile], []]
		mockResults.insertQueue = [[triggerRow], [{ id: 'evt-1' }]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/mini-apps/regen',
				{ file_id: fileId, app_name: 'Curriculum', target_actor_id: targetActorId },
				headers(),
			),
		)

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.trigger.type).toBe('cron')
		expect(json.trigger.name).toBe('Regen Curriculum daily')
		expect(json.trigger.enabled).toBe(true)
		expect(json.trigger.targetActorId).toBe(targetActorId)
		expect(json.file.id).toBe(fileId)
		expect(json.slot.id).toBe(MASKIN_STATE_SLOT_ID)
		expect(json.slot.window_key).toBe(MASKIN_APP_DATA_WINDOW_KEY)
		expect(json.cron).toBe(DAILY_REGEN_CRON)

		// One trigger insert + one audit event — no duplicate machinery.
		expect(calls.inserts).toHaveLength(2)
		const triggerInsert = calls.inserts[0] as Record<string, unknown>
		expect(triggerInsert.workspaceId).toBe(workspaceId)
		expect(triggerInsert.actionPrompt).toBe(
			buildDailyRegenActionPrompt({ id: fileId, name: 'curriculum.html' }),
		)
		const eventInsert = calls.inserts[1] as Record<string, unknown>
		expect(eventInsert.action).toBe('created')
		expect(eventInsert.entityType).toBe('trigger')
		expect((eventInsert.data as Record<string, unknown>).file_id).toBe(fileId)
	})

	it('DoD-2 — re-provisioning updates the SAME trigger in place (no duplicates)', async () => {
		const { app, mockResults, calls } = createImportTestApp(miniAppRegenRoutes, '/api/mini-apps')
		const member = buildWorkspaceMember({ workspaceId, actorId })
		const htmlFile = buildFile({
			workspaceId,
			id: fileId,
			name: 'curriculum.html',
			mimeType: 'text/html',
			sizeBytes: 120,
		})
		const existing = buildTrigger({
			id: '33333333-3333-3333-3333-333333333333',
			workspaceId,
			name: dailyRegenTriggerName('Curriculum'),
			type: 'cron',
			config: { expression: DAILY_REGEN_CRON, file_id: fileId },
			targetActorId,
			createdBy: actorId,
			enabled: false,
		})
		const updated = { ...existing, enabled: true, updatedAt: new Date() }
		// Select #1 member, #2 file, #3 existing trigger.
		mockResults.selectQueue = [[member], [htmlFile], [existing]]
		mockResults.updateQueue = [[updated]]
		mockResults.insertQueue = [[{ id: 'evt-1' }]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/mini-apps/regen',
				{ file_id: fileId, app_name: 'Curriculum', target_actor_id: targetActorId },
				headers(),
			),
		)

		expect(res.status).toBe(200)
		const json = await res.json()
		// Same trigger id, re-enabled — never a new object.
		expect(json.trigger.id).toBe(existing.id)
		expect(json.trigger.enabled).toBe(true)
		expect(calls.updates).toHaveLength(1)
		expect(calls.inserts).toHaveLength(1) // audit event only, no dup trigger
		expect(calls.inserts[0]?.action).toBe('updated')
	})

	it('rejects non-members', async () => {
		const { app, mockResults } = createImportTestApp(miniAppRegenRoutes, '/api/mini-apps')
		// No membership row → not a member.
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/mini-apps/regen',
				{ file_id: fileId, target_actor_id: targetActorId },
				headers(),
			),
		)

		expect(res.status).toBe(403)
	})

	it('rejects files that are not hosted html apps', async () => {
		const { app, mockResults } = createImportTestApp(miniAppRegenRoutes, '/api/mini-apps')
		const member = buildWorkspaceMember({ workspaceId, actorId })
		const mdFile = buildFile({
			workspaceId,
			id: fileId,
			name: 'notes.md',
			mimeType: 'text/markdown',
		})
		mockResults.selectQueue = [[member], [mdFile]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/mini-apps/regen',
				{ file_id: fileId, target_actor_id: targetActorId },
				headers(),
			),
		)

		expect(res.status).toBe(400)
	})

	it('does not take over a same-named trigger that regens a DIFFERENT file', async () => {
		const { app, mockResults, calls } = createImportTestApp(miniAppRegenRoutes, '/api/mini-apps')
		const member = buildWorkspaceMember({ workspaceId, actorId })
		const otherFileId = '44444444-4444-4444-4444-444444444444'
		const htmlFile = buildFile({
			workspaceId,
			id: fileId,
			name: 'index.html',
			mimeType: 'text/html',
			sizeBytes: 120,
		})
		// A pre-existing regen trigger for a DIFFERENT file that shares the name.
		const other = buildTrigger({
			id: '55555555-5555-5555-5555-555555555555',
			workspaceId,
			name: dailyRegenTriggerName('index.html'),
			type: 'cron',
			config: { expression: DAILY_REGEN_CRON, file_id: otherFileId },
			targetActorId,
			createdBy: actorId,
		})
		// Same-name lookup finds it, but the file_id in config does not match →
		// the route must provision a fresh trigger, never reconfigure the other.
		mockResults.selectQueue = [[member], [htmlFile], [other]]
		const created = buildTrigger({
			id: '66666666-6666-6666-6666-666666666666',
			workspaceId,
			name: dailyRegenTriggerName('index.html'),
			type: 'cron',
			config: { expression: DAILY_REGEN_CRON, file_id: fileId },
			targetActorId,
			createdBy: actorId,
		})
		mockResults.insertQueue = [[created], [{ id: 'evt-2' }]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/mini-apps/regen',
				{ file_id: fileId, app_name: 'index.html', target_actor_id: targetActorId },
				headers(),
			),
		)

		expect(res.status).toBe(200)
		expect(calls.updates).toHaveLength(0)
		expect(calls.inserts).toHaveLength(2) // new trigger + audit event, no takeover
	})
})

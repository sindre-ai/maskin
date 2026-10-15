import { events, imports, objects } from '@maskin/db/schema'
import type { ImportMapping } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { sweepErased } from '../../jobs/voice-retention-sweep'
import { runDialerTick } from '../../lib/outreach/voice/dialer'
import type { DialerConfig, DialerDeps } from '../../lib/outreach/voice/dialer'
import { createDrizzleDialerStore } from '../../lib/outreach/voice/dialer-store'
import { erasureMarkerFor, parseFounderActors } from '../../lib/outreach/voice/dnc-gate'
import { parseErasureKey } from '../../lib/outreach/voice/erasure-key'
import type { WorkspaceSettings } from '../../lib/types'
import { executeImport } from '../../services/import-processor'
import { buildImport, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The dial-time half of the erasure suppression marker against real Postgres: the dialer refuses
// a new contact whose number hashes to the marker of an erased contact, and the marker survives
// an import merge onto the erased row, and the window before the sweep has reached an erased row.
// Writing the marker is covered in voice-recordings.test.ts.

// Thu 2026-10-01 11:00 CEST, inside the dial window.
const NOW = new Date('2026-10-01T09:00:00Z')
const KEY = parseErasureKey('test-erasure-marker-key-0123456789-abcdef')
const NUMBER = '+4520123456'

const CONFIG: DialerConfig = {
	rateLimitPerMinute: 50,
	dailyCap: 500,
	fromNumber: '+4570000000',
	assistantId: 'assistant-1',
	connectionId: 'app-1',
	webhookUrl: 'https://maskin.test/api/integrations/telnyx/webhook',
}

const SETTINGS = {
	display_names: { contact: 'Contact' },
	statuses: { contact: ['voice_queued', 'deleted_by_request'] },
	field_definitions: {},
	relationship_types: [],
} as unknown as WorkspaceSettings

function markerOf(raw: string) {
	if (!KEY.ok) throw new Error('test key must parse')
	const marker = erasureMarkerFor(raw, KEY.key)
	if (!marker) throw new Error('test number must normalise')
	return marker
}

function seedContact(
	workspaceId: string,
	status: string,
	metadata: Record<string, unknown> = {},
	title = 'Pia Prospect',
) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'contact',
		title,
		status,
		metadata: { owner: 'sebk', phone: NUMBER, company_type: 'aps', ...metadata },
	})
}

/** What the retention sweep leaves behind: no number, an erased_at and the marker. */
function seedErased(workspaceId: string, number = NUMBER, title = 'Pia Prospect') {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'contact',
		title,
		status: 'deleted_by_request',
		metadata: { erased_at: '2026-09-30T03:41:00.000Z', erasure_marker: markerOf(number) },
	})
}

/** An erasure request the daily sweep has not reached: still holds its number, no marker, no erased_at. */
function seedErasedNotSwept(workspaceId: string, phone = NUMBER, title = 'Pia Prospect') {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'contact',
		title,
		status: 'deleted_by_request',
		metadata: { phone, email: 'pia@prospect.example' },
	})
}

/**
 * The real sweepErased against this Postgres. The seeded contact has no call, no blobs and no
 * events with a call id, so the in-memory storage and Telnyx stand-ins are never asked for anything.
 */
function runSweep() {
	const storage = {
		list: async () => [],
		delete: async () => {},
	} as unknown as StorageProvider
	const telnyx = () => ({
		listRecordings: async () => [],
		deleteRecording: async () => 'not_found' as const,
	})
	return sweepErased(db, storage, telnyx, KEY)
}

function deps(over: Partial<DialerDeps> = {}) {
	const createCall = vi.fn(async () => ({ callControlId: 'call-1', callSessionId: null }))
	const d: DialerDeps = {
		store: createDrizzleDialerStore(db),
		telnyx: { createCall },
		gate: {
			founders: parseFounderActors(JSON.stringify({ sebk: getTestActorId() })),
			findActor: async () => ({ type: 'human' }),
			erasure: KEY,
		},
		config: CONFIG,
		autosendEnabled: true,
		actorId: getTestActorId(),
		now: () => NOW,
		...over,
	}
	return { d, createCall }
}

async function rowOf(id: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, id))
	return row as typeof row & { metadata: Record<string, unknown> }
}

async function refusals(contactId: string) {
	return (await db.select().from(events).where(eq(events.entityId, contactId))).filter(
		(e) => e.action === 'dnc_refused',
	)
}

describe('dialer refuses a contact that matches an erased contact', () => {
	it('refuses a fresh contact with the erased contact number, once, and leaves its status alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedErased(ws.id)
		const fresh = await seedContact(ws.id, 'voice_queued', {}, 'Pia Prospect (new import)')
		const { d, createCall } = deps()

		const result = await runDialerTick(ws.id, d)
		await runDialerTick(ws.id, d)

		expect(createCall).not.toHaveBeenCalled()
		expect(result.refused_count).toBe(1)
		const refused = await refusals(fresh.id)
		expect(refused).toHaveLength(1)
		expect(refused[0]?.data).toEqual({ check: 'erased', reason: 'matches erased contact' })
		expect(JSON.stringify(refused[0])).not.toContain(markerOf(NUMBER))
		expect(JSON.stringify(refused[0])).not.toContain('20123456')
		expect((await rowOf(fresh.id)).status).toBe('voice_queued')
	})

	it('refuses the same number written with spaces or a 00 prefix', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedErased(ws.id)
		const spaced = await seedContact(ws.id, 'voice_queued', { phone: '+45 20 12 34 56' })
		const prefixed = await seedContact(ws.id, 'voice_queued', { phone: '0045 20123456' })
		const { d, createCall } = deps()

		await runDialerTick(ws.id, d)

		expect(createCall).not.toHaveBeenCalled()
		expect(await refusals(spaced.id)).toHaveLength(1)
		expect(await refusals(prefixed.id)).toHaveLength(1)
	})

	it('dials a contact with a different number', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedErased(ws.id)
		const other = await seedContact(ws.id, 'voice_queued', { phone: '+4520999999' })
		const { d, createCall } = deps()

		const result = await runDialerTick(ws.id, d)

		expect(result.dialed_count).toBe(1)
		expect(createCall).toHaveBeenCalledTimes(1)
		expect((await rowOf(other.id)).status).toBe('voice_dialing')
	})

	it('does not refuse on an erased contact from another workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const elsewhere = await insertWorkspace(db, getTestActorId())
		await seedErased(elsewhere.id)
		await seedContact(ws.id, 'voice_queued')
		const { d, createCall } = deps()

		await runDialerTick(ws.id, d)

		expect(createCall).toHaveBeenCalledTimes(1)
	})

	it('places no call for anyone while the key is not set, and says so', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const c = await seedContact(ws.id, 'voice_queued')
		const { d, createCall } = deps()
		d.gate.erasure = parseErasureKey(undefined)

		await runDialerTick(ws.id, d)

		expect(createCall).not.toHaveBeenCalled()
		const [refusal] = await refusals(c.id)
		expect(refusal?.data).toMatchObject({
			check: 'erased',
			reason: expect.stringContaining('VOICE_ERASURE_MARKER_KEY is not set'),
		})
	})
})

describe('dialer refuses a contact that matches an erased contact the sweep has not reached', () => {
	it('refuses the same number on an erased row that has no marker and no erased_at yet', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		// Written with spaces: the stored phone is compared the way the dialer normalises a number.
		const erased = await seedErasedNotSwept(ws.id, '+45 20 12 34 56')
		const fresh = await seedContact(ws.id, 'voice_queued', {}, 'Pia Prospect (new import)')
		const other = await seedContact(ws.id, 'voice_queued', { phone: '+4520999999' })
		const { d, createCall } = deps()

		const result = await runDialerTick(ws.id, d)

		const before = await rowOf(erased.id)
		expect(before.metadata.erased_at).toBeUndefined()
		expect(before.metadata.erasure_marker).toBeUndefined()
		expect(result.refused_count).toBe(1)
		expect(createCall).toHaveBeenCalledTimes(1)
		expect((await rowOf(other.id)).status).toBe('voice_dialing')
		const refused = await refusals(fresh.id)
		expect(refused).toHaveLength(1)
		expect(refused[0]?.data).toEqual({ check: 'erased', reason: 'matches erased contact' })
		expect(JSON.stringify(refused[0])).not.toContain('20123456')
		expect(JSON.stringify(refused[0])).not.toContain('20 12 34 56')
		expect((await rowOf(fresh.id)).status).toBe('voice_queued')
		expect(await refusals(other.id)).toHaveLength(0)
	})

	it('keeps refusing the same number through the marker once the sweep has run', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const erased = await seedErasedNotSwept(ws.id)
		const early = await seedContact(ws.id, 'voice_queued', {}, 'Pia Prospect (first import)')
		const { d, createCall } = deps()

		await runDialerTick(ws.id, d)
		expect(await refusals(early.id)).toHaveLength(1)

		await runSweep()

		// The number is gone from the erased row, so only the marker can be what refuses now.
		const swept = await rowOf(erased.id)
		expect(swept.status).toBe('deleted_by_request')
		expect(swept.metadata.phone).toBeUndefined()
		expect(swept.metadata.erased_at).toEqual(expect.any(String))
		expect(swept.metadata.erasure_marker).toBe(markerOf(NUMBER))
		expect(await createDrizzleDialerStore(db).hasUnsweptErasedNumber(ws.id, NUMBER)).toBe(false)

		const late = await seedContact(ws.id, 'voice_queued', {}, 'Pia Prospect (second import)')
		const result = await runDialerTick(ws.id, d)

		expect(createCall).not.toHaveBeenCalled()
		expect(result.refused_count).toBe(2)
		const refused = await refusals(late.id)
		expect(refused).toHaveLength(1)
		expect(refused[0]?.data).toEqual({ check: 'erased', reason: 'matches erased contact' })
		expect(JSON.stringify(refused[0])).not.toContain(markerOf(NUMBER))
		expect((await rowOf(late.id)).status).toBe('voice_queued')
	})
})

describe('the marker survives an import merge onto the erased row', () => {
	function mapping(): ImportMapping {
		return {
			typeMappings: [
				{
					objectType: 'contact',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						{ sourceColumn: 'status', targetField: 'status', transform: 'none', skip: false },
						{
							sourceColumn: 'phone',
							targetField: 'metadata.phone',
							transform: 'none',
							skip: false,
						},
						{
							sourceColumn: 'owner',
							targetField: 'metadata.owner',
							transform: 'none',
							skip: false,
						},
						{
							sourceColumn: 'company_type',
							targetField: 'metadata.company_type',
							transform: 'none',
							skip: false,
						},
					],
					defaultStatus: 'voice_queued',
					matchOn: 'title',
				},
			],
			relationships: [],
			onMatch: 'update',
		}
	}

	it('keeps metadata.erasure_marker when the file overwrites the status, and the dialer still refuses', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { settings: SETTINGS })
		const erased = await seedErased(ws.id)
		const [imp] = await db
			.insert(imports)
			.values(buildImport({ workspaceId: ws.id, createdBy: getTestActorId() }))
			.returning()

		const result = await executeImport(
			imp.id,
			[
				{
					name: 'Pia Prospect',
					status: 'voice_queued',
					phone: '+4520888888',
					owner: 'sebk',
					company_type: 'aps',
				},
			],
			mapping(),
			ws.id,
			getTestActorId(),
			SETTINGS,
			db,
		)

		expect(result).toMatchObject({ updatedCount: 1 })
		const row = await rowOf(erased.id)
		expect(row.status).toBe('voice_queued')
		expect(row.metadata.erasure_marker).toBe(markerOf(NUMBER))

		const { d, createCall } = deps()
		await runDialerTick(ws.id, d)

		expect(createCall).not.toHaveBeenCalled()
		const [refusal] = await refusals(erased.id)
		expect(refusal?.data).toEqual({ check: 'erased', reason: 'matches erased contact' })
	})
})

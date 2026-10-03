import { events, objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { processVoiceRetentionSweep } from '../../jobs/voice-retention-sweep'
import type { CallRecording } from '../../lib/integrations/providers/telnyx/client'
import { postCallHooks } from '../../lib/outreach/voice/post-call'
import {
	type MirrorDeps,
	buildAccessExport,
	mirrorCallArtifacts,
	recordingKey,
	stampVoiceTouch,
	transcriptKey,
	voiceBlobPrefix,
} from '../../lib/outreach/voice/recordings'
import {
	configureVoiceArtifactStorage,
	voiceMirrorHook,
} from '../../lib/outreach/voice/recordings-hook'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Mirror, retention sweep and erasure against real Postgres. S3 and Telnyx are in-memory
// fakes: they verify our logic, not that Telnyx or S3 behave as assumed.

function fakeStorage() {
	const blobs = new Map<string, Buffer>()
	const provider: StorageProvider = {
		async put(key, data) {
			blobs.set(key, Buffer.from(data as Buffer))
		},
		async get(key) {
			const hit = blobs.get(key)
			if (!hit) throw new Error(`no such key ${key}`)
			return hit
		},
		async list(prefix) {
			return [...blobs.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...blobs.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, v]) => ({ key, size: v.length }))
		},
		async delete(key) {
			blobs.delete(key)
		},
		async exists(key) {
			return blobs.has(key)
		},
		async ensureBucket() {},
	}
	return { blobs, provider }
}

const MP3_URL = 'https://files.telnyx.test/rec.mp3'
const JSON_URL = 'https://files.telnyx.test/transcript.json'
const TRANSCRIPT = JSON.stringify({
	turns: [{ role: 'assistant', text: 'Hi, this is an AI caller.' }],
})

function okFetch(): typeof fetch {
	return (async (url: string | URL | Request) => {
		const u = String(url)
		if (u === MP3_URL) return new Response(Buffer.from('mp3-bytes'), { status: 200 })
		if (u === JSON_URL) return new Response(TRANSCRIPT, { status: 200 })
		return new Response('nope', { status: 404 })
	}) as typeof fetch
}

async function setup(overrides: Record<string, unknown> = {}) {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		title: 'Pia Prospect',
		status: 'voice_declined',
		content: 'Pia, head of ops, mobile +4511111111',
		metadata: { email: 'pia@prospect.example', last_call_id: 'call-1' },
		...overrides,
	})
	return { workspaceId: ws.id, contactId: contact.id }
}

const fx = () => {
	const storage = fakeStorage()
	const sleep = vi.fn(async () => {})
	const findRecording = vi.fn(async (): Promise<CallRecording | null> => null)
	const deps = (extra: Partial<MirrorDeps> = {}): MirrorDeps => ({
		db,
		storage: storage.provider,
		findRecording,
		fetchImpl: okFetch(),
		sleep,
		retryDelaysMs: [1, 2, 3],
		...extra,
	})
	return { storage, sleep, findRecording, deps }
}

const call = (callId = 'call-1', endedAt = new Date('2026-10-03T12:00:00.000Z')) => ({
	callId,
	endedAt,
	recordingUrl: MP3_URL,
	transcriptUrl: JSON_URL,
})

async function rowOf(id: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, id))
	return row as typeof row & { metadata: Record<string, unknown> }
}

describe('mirrorCallArtifacts', () => {
	it('writes the mp3 and transcript under voice-outreach/<contact>/<call> and stamps the contact', async () => {
		const s = await setup()
		const { storage, deps } = fx()
		const result = await mirrorCallArtifacts(s, call(), deps())

		expect(result).toMatchObject({ outcome: 'mirrored', attempts: 1 })
		expect([...storage.blobs.keys()].sort()).toEqual([
			`voice-outreach/${s.contactId}/call-1.json`,
			`voice-outreach/${s.contactId}/call-1.mp3`,
		])
		expect(storage.blobs.get(recordingKey(s.contactId, 'call-1'))?.toString()).toBe('mp3-bytes')
		expect(storage.blobs.get(transcriptKey(s.contactId, 'call-1'))?.toString()).toBe(TRANSCRIPT)

		const { metadata } = await rowOf(s.contactId)
		expect(metadata).toMatchObject({
			last_call_recording_id: recordingKey(s.contactId, 'call-1'),
			last_call_transcript_id: transcriptKey(s.contactId, 'call-1'),
			voice_last_touch_at: '2026-10-03T12:00:00.000Z',
			voice_first_touch_at: '2026-10-03T12:00:00.000Z',
			retention_expires_at: '2028-10-03T12:00:00.000Z',
			// untouched keys survive the merge patch
			email: 'pia@prospect.example',
			last_call_id: 'call-1',
		})
	})

	it('looks the recording up by call id when the hangup carried no URL', async () => {
		const s = await setup()
		const { storage, findRecording, deps } = fx()
		findRecording.mockResolvedValue({ recordingId: 'rec-1', status: 'completed', mp3Url: MP3_URL })
		const result = await mirrorCallArtifacts(s, { ...call(), recordingUrl: null }, deps())

		expect(result.outcome).toBe('mirrored')
		expect(findRecording).toHaveBeenCalledWith('call-1')
		expect(storage.blobs.size).toBe(2)
	})

	it('retries a recording Telnyx has not finished, then mirrors it', async () => {
		const s = await setup()
		const { storage, sleep, findRecording, deps } = fx()
		findRecording
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ recordingId: 'rec-1', status: 'processing', mp3Url: null })
			.mockResolvedValue({ recordingId: 'rec-1', status: 'completed', mp3Url: MP3_URL })
		const result = await mirrorCallArtifacts(s, { ...call(), recordingUrl: null }, deps())

		expect(result).toMatchObject({ outcome: 'mirrored', attempts: 3 })
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1, 2])
		expect(storage.blobs.size).toBe(2)
	})

	it('retries a failed download, then mirrors it', async () => {
		const s = await setup()
		const { storage, sleep, deps } = fx()
		let mp3Hits = 0
		const flaky = (async (url: string | URL | Request) => {
			if (String(url) === MP3_URL && ++mp3Hits === 1) return new Response('boom', { status: 503 })
			return okFetch()(url)
		}) as typeof fetch
		const result = await mirrorCallArtifacts(s, call(), deps({ fetchImpl: flaky }))

		expect(result).toMatchObject({ outcome: 'mirrored', attempts: 2 })
		expect(sleep).toHaveBeenCalledTimes(1)
		expect(storage.blobs.size).toBe(2)
	})

	it('gives up after the last retry and leaves no blobs and no stamp', async () => {
		const s = await setup()
		const { storage, deps } = fx()
		const result = await mirrorCallArtifacts(
			s,
			call(),
			deps({ fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch }),
		)

		expect(result).toMatchObject({ outcome: 'failed', attempts: 4 })
		expect(storage.blobs.size).toBe(0)
		const { metadata } = await rowOf(s.contactId)
		expect(metadata.voice_last_touch_at).toBeUndefined()
		expect(metadata.last_call_recording_id).toBeUndefined()
	})

	it('skips a contact that is already deleted_by_request and writes nothing', async () => {
		const s = await setup({ status: 'deleted_by_request' })
		const { storage, deps } = fx()
		const result = await mirrorCallArtifacts(s, call(), deps())

		expect(result).toEqual({ outcome: 'skipped_erased' })
		expect(storage.blobs.size).toBe(0)
		expect((await rowOf(s.contactId)).metadata.voice_last_touch_at).toBeUndefined()
	})

	it('leaves no blobs when the contact is erased while the mirror is mid-flight', async () => {
		const s = await setup()
		const { storage, deps } = fx()
		// The erasure lands after the pre-attempt check, during the transcript download.
		const erasingFetch = (async (url: string | URL | Request) => {
			if (String(url) === JSON_URL) {
				await db
					.update(objects)
					.set({ status: 'deleted_by_request' })
					.where(eq(objects.id, s.contactId))
			}
			return okFetch()(url)
		}) as typeof fetch
		const result = await mirrorCallArtifacts(s, call(), deps({ fetchImpl: erasingFetch }))

		expect(result).toEqual({ outcome: 'skipped_erased' })
		expect(storage.blobs.size).toBe(0)
		const row = await rowOf(s.contactId)
		expect(row.status).toBe('deleted_by_request')
		expect(row.metadata.voice_last_touch_at).toBeUndefined()
	})
})

describe('stampVoiceTouch', () => {
	it('sets voice_first_touch_at once and moves voice_last_touch_at only forward', async () => {
		const s = await setup()
		const at = (iso: string) => stampVoiceTouch(db, { ...s, touchedAt: new Date(iso) })

		await at('2026-10-03T12:00:00.000Z')
		await at('2026-12-01T09:30:00.000Z')
		await at('2026-11-01T00:00:00.000Z') // an older call finishing late

		const { metadata } = await rowOf(s.contactId)
		expect(metadata.voice_first_touch_at).toBe('2026-10-03T12:00:00.000Z')
		expect(metadata.voice_last_touch_at).toBe('2026-12-01T09:30:00.000Z')
		expect(metadata.retention_expires_at).toBe('2028-12-01T09:30:00.000Z')
	})

	it('merges into metadata another writer changed in the meantime', async () => {
		const s = await setup()
		await Promise.all([
			stampVoiceTouch(db, { ...s, touchedAt: new Date('2026-10-03T12:00:00.000Z') }),
			db
				.update(objects)
				.set({
					metadata: (await import('drizzle-orm'))
						.sql`${objects.metadata} || '{"consent_call_id":"call-1"}'::jsonb`,
				})
				.where(eq(objects.id, s.contactId)),
		])
		const { metadata } = await rowOf(s.contactId)
		expect(metadata.consent_call_id).toBe('call-1')
		expect(metadata.voice_last_touch_at).toBe('2026-10-03T12:00:00.000Z')
	})

	it('writes nothing and reports false for a deleted_by_request contact', async () => {
		const s = await setup({ status: 'deleted_by_request' })
		const applied = await stampVoiceTouch(db, { ...s, touchedAt: new Date() })
		expect(applied).toBe(false)
		expect((await rowOf(s.contactId)).metadata.voice_last_touch_at).toBeUndefined()
	})
})

async function seedConsent(s: { workspaceId: string; contactId: string }) {
	await db.insert(events).values({
		workspaceId: s.workspaceId,
		actorId: getTestActorId(),
		action: 'voice_followup_email_requested',
		entityType: 'object',
		entityId: s.contactId,
		data: {
			call_id: 'call-1',
			prospect_quote: 'yes, send it',
			confirmed_address: 'pia@prospect.example',
		},
	})
}

const consentEvents = async (contactId: string) =>
	(await db.select().from(events).where(eq(events.entityId, contactId))).filter(
		(e) => e.action === 'voice_followup_email_requested',
	)

const consentFields = {
	consent_basis: 'gdpr_6_1_f',
	consent_call_id: 'call-1',
	consent_captured_at: '2026-10-03T12:05:00.000Z',
}

describe('voice retention sweep', () => {
	it('deletes blobs past retention_expires_at, clears the blob ids, and keeps consent evidence', async () => {
		const s = await setup({
			metadata: {
				...consentFields,
				last_call_recording_id: 'k.mp3',
				last_call_transcript_id: 'k.json',
				voice_last_touch_at: '2024-01-01T00:00:00.000Z',
				retention_expires_at: '2026-01-01T00:00:00.000Z',
			},
		})
		await seedConsent(s)
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('a'))
		await storage.provider.put(transcriptKey(s.contactId, 'call-1'), Buffer.from('b'))

		const result = await processVoiceRetentionSweep(
			db,
			storage.provider,
			new Date('2026-10-03T12:00:00.000Z'),
		)

		expect(result).toEqual({ expired: 1, erased: 0 })
		expect(storage.blobs.size).toBe(0)
		const row = await rowOf(s.contactId)
		expect(row.metadata.last_call_recording_id).toBeUndefined()
		expect(row.metadata.last_call_transcript_id).toBeUndefined()
		expect(row.metadata).toMatchObject(consentFields)
		expect(row.status).toBe('voice_declined')
		expect(await consentEvents(s.contactId)).toHaveLength(1)
	})

	it('keeps blobs that are not yet past retention_expires_at', async () => {
		const s = await setup({
			metadata: {
				last_call_recording_id: 'k.mp3',
				voice_last_touch_at: '2026-09-01T00:00:00.000Z',
				retention_expires_at: '2028-09-01T00:00:00.000Z',
			},
		})
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('a'))

		const result = await processVoiceRetentionSweep(db, storage.provider, new Date('2026-10-03'))

		expect(result.expired).toBe(0)
		expect(storage.blobs.size).toBe(1)
		expect((await rowOf(s.contactId)).metadata.last_call_recording_id).toBe('k.mp3')
	})

	it('defaults to 24 months from voice_last_touch_at when retention_expires_at is missing', async () => {
		const s = await setup({
			metadata: {
				last_call_recording_id: 'k.mp3',
				voice_last_touch_at: '2024-09-01T00:00:00.000Z',
			},
		})
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('a'))

		const before = await processVoiceRetentionSweep(db, storage.provider, new Date('2026-08-31'))
		expect(before.expired).toBe(0)
		const after = await processVoiceRetentionSweep(db, storage.provider, new Date('2026-09-02'))
		expect(after.expired).toBe(1)
		expect(storage.blobs.size).toBe(0)
	})
})

describe('voice erasure', () => {
	it('erases blobs, content and personal metadata on the next tick, and keeps consent evidence', async () => {
		const s = await setup({
			status: 'deleted_by_request',
			metadata: {
				...consentFields,
				email: 'pia@prospect.example',
				phone: '+4511111111',
				last_call_id: 'call-1',
				voice_tool_trace: [{ tool_name: 'request_followup_email' }],
				last_call_recording_id: 'k.mp3',
				voice_last_touch_at: '2026-10-03T12:00:00.000Z',
				retention_expires_at: '2028-10-03T12:00:00.000Z',
			},
		})
		await seedConsent(s)
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('a'))
		await storage.provider.put(transcriptKey(s.contactId, 'call-1'), Buffer.from('b'))
		const other = await setup()
		await storage.provider.put(recordingKey(other.contactId, 'call-9'), Buffer.from('keep'))

		const result = await processVoiceRetentionSweep(db, storage.provider)

		expect(result).toEqual({ expired: 0, erased: 1 })
		expect([...storage.blobs.keys()]).toEqual([recordingKey(other.contactId, 'call-9')])
		const row = await rowOf(s.contactId)
		expect(row.status).toBe('deleted_by_request')
		expect(row.content).toBeNull()
		expect(Object.keys(row.metadata).sort()).toEqual(
			[...Object.keys(consentFields), 'erased_at'].sort(),
		)
		expect(row.metadata).toMatchObject(consentFields)
		expect(await consentEvents(s.contactId)).toHaveLength(1)

		// A second tick finds nothing left to do.
		expect(await processVoiceRetentionSweep(db, storage.provider)).toEqual({
			expired: 0,
			erased: 0,
		})
	})

	it('does not strip the row when S3 deletion fails, so the next tick retries', async () => {
		const s = await setup({ status: 'deleted_by_request' })
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('a'))
		const failing: StorageProvider = {
			...storage.provider,
			delete: async () => {
				throw new Error('s3 down')
			},
		}

		const result = await processVoiceRetentionSweep(db, failing)

		expect(result.erased).toBe(0)
		const row = await rowOf(s.contactId)
		expect(row.content).not.toBeNull()
		expect(row.metadata.erased_at).toBeUndefined()
		expect((await processVoiceRetentionSweep(db, storage.provider)).erased).toBe(1)
	})
})

describe('buildAccessExport', () => {
	it('zips the contact row and every voice-outreach blob for that contact only', async () => {
		const s = await setup()
		const { storage } = fx()
		await storage.provider.put(recordingKey(s.contactId, 'call-1'), Buffer.from('mp3-1'))
		await storage.provider.put(transcriptKey(s.contactId, 'call-1'), Buffer.from(TRANSCRIPT))
		const other = await setup()
		await storage.provider.put(recordingKey(other.contactId, 'call-9'), Buffer.from('not-yours'))

		const zip = await buildAccessExport(db, storage.provider, s)
		expect(zip).not.toBeNull()
		const entries = new AdmZip(zip as Buffer).getEntries().map((e) => e.entryName)
		expect(entries.sort()).toEqual(
			[
				'contact.json',
				`${voiceBlobPrefix(s.contactId)}call-1.json`,
				`${voiceBlobPrefix(s.contactId)}call-1.mp3`,
			].sort(),
		)
		const contactJson = JSON.parse(new AdmZip(zip as Buffer).readAsText('contact.json')) as {
			title: string
		}
		expect(contactJson.title).toBe('Pia Prospect')
	})

	it('returns null for a contact that does not exist in the workspace', async () => {
		const s = await setup()
		const { storage } = fx()
		expect(
			await buildAccessExport(db, storage.provider, {
				workspaceId: s.workspaceId,
				contactId: '00000000-0000-4000-8000-000000000000',
			}),
		).toBeNull()
	})
})

describe('voice mirror post-call hook', () => {
	const hangup = (s: { workspaceId: string; contactId: string }, status: string) => ({
		db,
		workspaceId: s.workspaceId,
		contactId: s.contactId,
		callId: 'call-1',
		status,
		hangupCause: 'normal_clearing',
		durationS: 60,
		endedAt: '2026-10-03T12:00:00.000Z',
		recordingUrl: MP3_URL,
		transcriptUrl: JSON_URL,
	})

	it('is registered in the default hook list', () => {
		expect(postCallHooks.map((h) => h.name)).toContain('voice-mirror')
	})

	it('returns before the mirror finishes, then mirrors in the background', async () => {
		const s = await setup()
		const { storage } = fx()
		configureVoiceArtifactStorage(storage.provider)
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
			await gate
			return okFetch()(url)
		}) as typeof fetch)
		try {
			const returned = voiceMirrorHook.run(hangup(s, 'voice_meeting_booked'))
			expect(returned).toBeUndefined() // nothing for the webhook to await
			expect(storage.blobs.size).toBe(0) // the mirror is still blocked on the download
			release()
			await vi.waitFor(() => expect(storage.blobs.size).toBe(2))
			await vi.waitFor(async () =>
				expect((await rowOf(s.contactId)).metadata.voice_last_touch_at).toBe(
					'2026-10-03T12:00:00.000Z',
				),
			)
		} finally {
			vi.unstubAllGlobals()
			configureVoiceArtifactStorage(null)
		}
	})

	it('does nothing for statuses without a completed leg', async () => {
		const s = await setup()
		const { storage } = fx()
		configureVoiceArtifactStorage(storage.provider)
		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)
		try {
			voiceMirrorHook.run(hangup(s, 'voice_no_answer'))
			voiceMirrorHook.run(hangup(s, 'follow_up_later'))
			await new Promise((r) => setTimeout(r, 50))
			expect(fetchSpy).not.toHaveBeenCalled()
			expect(storage.blobs.size).toBe(0)
		} finally {
			vi.unstubAllGlobals()
			configureVoiceArtifactStorage(null)
		}
	})
})

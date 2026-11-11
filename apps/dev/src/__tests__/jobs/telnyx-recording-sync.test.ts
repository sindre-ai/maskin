import { describe, expect, it } from 'vitest'
import { recordingDescription, recordingFileName } from '../../jobs/telnyx-recording-sync'
import { MAX_RECORDING_BYTES, downloadRecording, listRecordings } from '../../lib/telnyx-recordings'

const rec = {
	id: 'f5cdc44a-9bd1-4f3a-86a0-3a859fca01f3',
	callSessionId: '59c9b05c-203c-4d10-b702-039aa1352d18',
	from: '+4570000000',
	to: '+4551515484',
	status: 'completed',
	durationMillis: 24_400,
	startedAt: '2026-11-10T09:17:12.000Z',
	mp3Url: 'https://example.test/a.mp3',
}
const contact = {
	id: 'c1',
	name: 'Lars Orbe',
	role: 'Medindehaver',
	company: 'Bygmestrene Lars Orbe og Jim Dideriksen ApS',
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('recording file name and description', () => {
	it('names the file after the company and the UTC start', () => {
		expect(recordingFileName(rec, contact)).toBe(
			'call-bygmestrene-lars-orbe-og-jim-dideriksen-aps-2026-11-10-0917utc.mp3',
		)
	})

	it('falls back to the number when no person matches', () => {
		expect(recordingFileName(rec, null)).toBe('call-4551515484-2026-11-10-0917utc.mp3')
	})

	it('folds Danish letters', () => {
		const name = recordingFileName(rec, { ...contact, company: 'Mortens Køreskole' })
		expect(name).toBe('call-mortens-koreskole-2026-11-10-0917utc.mp3')
	})

	it('puts the recording id and the erase flag in the description', () => {
		const text = recordingDescription(rec, contact)
		expect(text).toContain(`Telnyx recording ${rec.id}`)
		expect(text).toContain('24 s')
		expect(text).toContain('number +4551515484 (Lars Orbe, Medindehaver,')
		expect(text.endsWith('Erase on request.')).toBe(true)
	})

	it('says so when no person matches', () => {
		expect(recordingDescription(rec, null)).toContain('no matching person found')
	})
})

describe('listRecordings', () => {
	it('walks every page and sends the key and the date filter', async () => {
		const calls: URL[] = []
		const fetchFn = (async (url: URL, init: RequestInit) => {
			calls.push(url)
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
			const page = Number(url.searchParams.get('page[number]'))
			return json({
				data: [
					{
						id: `r${page}`,
						recording_started_at: '2026-11-10T09:00:00Z',
						to: '+4511111111',
						download_urls: { mp3: `https://example.test/${page}.mp3` },
					},
				],
				meta: { total_pages: 2 },
			})
		}) as unknown as typeof fetch

		const out = await listRecordings('k', new Date('2026-11-09T00:00:00Z'), fetchFn)

		expect(out.map((r) => r.id)).toEqual(['r1', 'r2'])
		expect(calls).toHaveLength(2)
		expect(calls[0]?.searchParams.get('filter[created_at][gte]')).toBe('2026-11-09T00:00:00.000Z')
	})

	it('throws on a failed page instead of returning a partial list', async () => {
		const fetchFn = (async () =>
			json(
				{ errors: [{ code: '10007', detail: 'An unexpected error occurred.' }] },
				500,
			)) as unknown as typeof fetch
		await expect(listRecordings('k', new Date(), fetchFn)).rejects.toMatchObject({
			status: 500,
			code: '10007',
		})
	})
})

describe('downloadRecording', () => {
	it('returns the bytes', async () => {
		const fetchFn = (async () => new Response(Buffer.from([1, 2, 3]))) as unknown as typeof fetch
		expect((await downloadRecording('https://x.test/a.mp3', fetchFn)).byteLength).toBe(3)
	})

	it('rejects an empty body so the recording is retried', async () => {
		const fetchFn = (async () => new Response(Buffer.alloc(0))) as unknown as typeof fetch
		await expect(downloadRecording('https://x.test/a.mp3', fetchFn)).rejects.toThrow('empty')
	})

	it('rejects a body over the cap', async () => {
		const fetchFn = (async () =>
			new Response(Buffer.alloc(MAX_RECORDING_BYTES + 1))) as unknown as typeof fetch
		await expect(downloadRecording('https://x.test/a.mp3', fetchFn)).rejects.toThrow('cap')
	})
})

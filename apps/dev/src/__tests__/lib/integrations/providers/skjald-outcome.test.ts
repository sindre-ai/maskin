import { skjaldOutcomePayloadSchema } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { renderOutcomeContent } from '../../../../lib/integrations/providers/skjald/meeting-sync'

function payload(overrides: Record<string, unknown> = {}) {
	return skjaldOutcomePayloadSchema.parse({
		session: { id: 'm1', title: 'Call', startedAt: '2026-10-07T09:00:00Z', duration: 60 },
		outcome: { summary: 'Short summary.', decisions: ['Do X'], actions: ['Send Y'], notes: [] },
		...overrides,
	})
}

describe('skjaldOutcomePayloadSchema', () => {
	it('accepts the payload Skjald sends, including fields it does not read', () => {
		const parsed = skjaldOutcomePayloadSchema.safeParse({
			session: {
				id: 'm1',
				title: 'Call',
				startedAt: '2026-10-07T09:00:00Z',
				duration: 60,
				languages: [],
				tag: null,
			},
			outcome: { summary: 's', decisions: [], actions: [], notes: [] },
			consent: { anything: true },
			device: { model: 'iPhone', appVersion: '1.0' },
			sentAt: '2026-10-07T09:01:00Z',
		})
		expect(parsed.success).toBe(true)
	})

	it('rejects a payload without a session id', () => {
		const parsed = skjaldOutcomePayloadSchema.safeParse({
			session: { id: '', title: 'Call', startedAt: 'x', duration: 1 },
			outcome: { summary: 's' },
		})
		expect(parsed.success).toBe(false)
	})
})

describe('renderOutcomeContent', () => {
	it('lays out summary, decisions and actions, and leaves out empty sections', () => {
		expect(renderOutcomeContent(payload())).toBe(
			[
				'## Summary',
				'Short summary.',
				'',
				'## Decisions',
				'- Do X',
				'',
				'## Actions',
				'- Send Y',
			].join('\n'),
		)
	})

	it('appends the transcript only when one was sent', () => {
		const withTranscript = renderOutcomeContent(
			payload({ transcript: [{ t: 0, speaker: 'Anna', text: 'Hi' }] }),
		)
		expect(withTranscript).toContain('## Transcript\n**Anna:** Hi')
		expect(renderOutcomeContent(payload())).not.toContain('Transcript')
	})

	it('is empty when the outcome has nothing in it', () => {
		const empty = payload({ outcome: { summary: '  ', decisions: [' '], actions: [], notes: [] } })
		expect(renderOutcomeContent(empty)).toBe('')
	})
})

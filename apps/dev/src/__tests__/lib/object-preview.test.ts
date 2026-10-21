import { describe, expect, it } from 'vitest'
import { listProviders } from '../../lib/integrations/registry'
import { buildObjectPreview, listDeliverableKinds } from '../../lib/object-preview'

describe('buildObjectPreview', () => {
	it('returns null for an object without a declared kind', () => {
		expect(buildObjectPreview({ content: 'Hello', metadata: {} })).toBeNull()
		expect(
			buildObjectPreview({ content: 'Hello', metadata: { kind: 'carrier_pigeon' } }),
		).toBeNull()
		expect(buildObjectPreview({ content: 'Hello', metadata: null })).toBeNull()
	})

	it('previews a sales task filed with channel linkedin_dm as a LinkedIn message', () => {
		const preview = buildObjectPreview({
			content: 'Thanks Liz, that is a fair answer.',
			metadata: { source: 'sales_conversation', channel: 'linkedin_dm', priority: 'P1' },
		})
		expect(preview).toMatchObject({
			kind: 'linkedin_message',
			label: 'LinkedIn message',
			provider: 'linkedin-unipile',
			body: 'Thanks Liz, that is a fair answer.',
			missing: [],
		})
	})

	it('shows what a reply answers without sending it or approving it', () => {
		const base = {
			content: 'Thanks Liz.',
			metadata: { channel: 'linkedin_dm', to: 'Liz Benison', thread_id: 't-1' },
		}
		const plain = buildObjectPreview(base)
		const withContext = buildObjectPreview({
			...base,
			metadata: { ...base.metadata, reply_to: 'We have governance already.' },
		})
		expect(withContext?.context).toBe('We have governance already.')
		expect(plain?.context).toBeNull()
		// What it answers is not sent, so changing it must not withdraw an approval.
		expect(withContext?.content_hash).toBe(plain?.content_hash)
	})

	it('warns, but does not block, when a recommended recipient is not filed', () => {
		const preview = buildObjectPreview({
			content: 'Thanks Liz.',
			metadata: { channel: 'linkedin_dm' },
		})
		expect(preview?.warnings).toContain('To is not filed.')
		expect(preview?.missing).toEqual([])
	})

	it('names who a reply goes to when it is filed, and keeps the conversation id out of the card', () => {
		const preview = buildObjectPreview({
			content: 'Thanks Liz.',
			metadata: { channel: 'linkedin_dm', to: 'Liz Benison', thread_id: 't-1' },
		})
		expect(preview?.recipients).toEqual([{ role: 'to', name: null, address: 'Liz Benison' }])
		expect(preview?.warnings).toEqual([])
		expect(JSON.stringify(preview)).not.toContain('t-1')
	})

	it('lets an explicit kind win over a channel match', () => {
		const preview = buildObjectPreview({
			content: 'Hi',
			metadata: { kind: 'email', channel: 'linkedin_dm', to: 'a@b.dk', subject: 'Hello' },
		})
		expect(preview?.kind).toBe('email')
	})

	it('builds an email preview from metadata and content', () => {
		const preview = buildObjectPreview({
			content: 'Hi Mette,\n\nThursday works.',
			metadata: {
				kind: 'email',
				to: 'Mette Holm <mette@northwind.dk>',
				cc: 'dan@northwind.dk',
				subject: 'Thursday',
			},
		})
		expect(preview).toMatchObject({
			kind: 'email',
			label: 'Email',
			provider: 'gmail',
			subject: 'Thursday',
			body: 'Hi Mette,\n\nThursday works.',
			missing: [],
			warnings: [],
		})
		expect(preview?.recipients).toEqual([
			{ role: 'to', name: 'Mette Holm', address: 'mette@northwind.dk' },
			{ role: 'cc', name: null, address: 'dan@northwind.dk' },
		])
	})

	it('reads a leading Subject line when the metadata has no subject', () => {
		const preview = buildObjectPreview({
			content: 'Subject: Thursday\n\nHi Mette',
			metadata: { kind: 'email', to: 'mette@northwind.dk' },
		})
		expect(preview?.subject).toBe('Thursday')
		expect(preview?.body).toBe('Hi Mette')
		expect(preview?.missing).toEqual([])
	})

	it('lists what is missing so the draft cannot be approved', () => {
		const preview = buildObjectPreview({ content: '', metadata: { kind: 'email' } })
		expect(preview?.missing).toEqual(['To', 'Subject', 'Message'])
	})

	it('warns about an address that is not one instead of failing', () => {
		const preview = buildObjectPreview({
			content: 'Hi',
			metadata: { kind: 'email', to: 'Mette', subject: 'Hi' },
		})
		expect(preview?.warnings).toEqual(['"Mette" does not look like an email address.'])
	})

	it('warns when the text is over the channel limit', () => {
		const preview = buildObjectPreview({
			content: 'x'.repeat(100_005),
			metadata: { kind: 'email', to: 'a@b.dk', subject: 'Hi' },
		})
		expect(preview?.warnings).toEqual(['The text is 5 characters over the 100000 limit.'])
	})
})

describe('deliverables declarations', () => {
	it('declares each kind once across providers', () => {
		const kinds = listProviders().flatMap((p) => (p.config.deliverables ?? []).map((d) => d.kind))
		expect(new Set(kinds).size).toBe(kinds.length)
		expect(
			listDeliverableKinds()
				.map((k) => k.deliverable.kind)
				.sort(),
		).toEqual([...kinds].sort())
	})

	it('gives every kind a send tool and at most one field per slot', () => {
		for (const { deliverable } of listDeliverableKinds()) {
			expect(deliverable.sendTool).not.toBe('')
			const keys = deliverable.fields.map((f) => f.key)
			expect(new Set(keys).size).toBe(keys.length)
			expect(deliverable.fields.filter((f) => f.slot === 'subject').length).toBeLessThanOrEqual(1)
		}
	})
})

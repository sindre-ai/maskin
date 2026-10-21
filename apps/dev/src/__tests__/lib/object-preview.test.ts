import { createHash } from 'node:crypto'
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

const POST_WITH_HEADER = [
	'Account: sebk_personal',
	'Voice: sebastian-voice',
	'Angle: giveaway',
	'Scheduled: 2026-10-27',
	'',
	'--- POST ---',
	'Most agent demos fail on the handoff.',
	'',
	'Here is the one-page spec we use.',
	'',
	'--- MEDIA ---',
	'none',
].join('\n')

describe('buildObjectPreview, other channels', () => {
	it('previews a LinkedIn message to a name and a profile link', () => {
		const preview = buildObjectPreview({
			content: 'Hej Merethe, tak for forbindelsen.',
			metadata: {
				kind: 'linkedin_message',
				to: 'Merethe Aas <https://www.linkedin.com/in/merethe-aas>',
			},
		})
		expect(preview).toMatchObject({
			kind: 'linkedin_message',
			label: 'LinkedIn message',
			provider: 'linkedin-unipile',
			subject: null,
			details: [],
			maxLength: 8000,
			missing: [],
			warnings: [],
		})
		expect(preview?.recipients).toEqual([
			{ role: 'to', name: 'Merethe Aas', address: 'https://www.linkedin.com/in/merethe-aas' },
		])
	})

	it('does not call a LinkedIn profile link a bad email address', () => {
		const preview = buildObjectPreview({
			content: 'Hi',
			metadata: { kind: 'linkedin_message', to: 'https://www.linkedin.com/in/x' },
		})
		expect(preview?.warnings).toEqual([])
	})

	it('needs a recipient before a LinkedIn connection request can be approved', () => {
		const preview = buildObjectPreview({
			content: 'Hi',
			metadata: { kind: 'linkedin_connection_request' },
		})
		expect(preview?.missing).toEqual(['To'])
	})

	it('warns when a connection note is over the 200 character invite limit', () => {
		const preview = buildObjectPreview({
			content: 'x'.repeat(205),
			metadata: { kind: 'linkedin_connection_request', to: 'Dan Jensen' },
		})
		expect(preview?.label).toBe('LinkedIn connection request')
		expect(preview?.warnings).toEqual(['The text is 5 characters over the 200 limit.'])
	})

	it('previews a Slack message with its channel as a detail line', () => {
		const preview = buildObjectPreview({
			content: 'Fix is live.',
			metadata: { kind: 'slack_message', channel: '#coach-maskin' },
		})
		expect(preview).toMatchObject({
			kind: 'slack_message',
			label: 'Slack message',
			provider: 'slack',
			recipients: [],
			details: [{ label: 'Channel', value: '#coach-maskin' }],
			missing: [],
		})
	})

	it('needs a channel before a Slack message can be approved', () => {
		const preview = buildObjectPreview({ content: 'Hi', metadata: { kind: 'slack_message' } })
		expect(preview?.missing).toEqual(['Channel'])
	})

	it('shows only the post of a LinkedIn post that carries a header', () => {
		const preview = buildObjectPreview({
			content: POST_WITH_HEADER,
			metadata: { kind: 'linkedin_post', account: 'Sebastian Krumhausen' },
		})
		expect(preview?.body).toBe(
			'Most agent demos fail on the handoff.\n\nHere is the one-page spec we use.',
		)
		expect(preview?.details).toEqual([{ label: 'Posting as', value: 'Sebastian Krumhausen' }])
		expect(preview?.maxLength).toBe(3000)
		expect(preview?.missing).toEqual([])
	})

	it("previews the Copywriter's posts without anyone adding a kind", () => {
		const preview = buildObjectPreview({
			content: POST_WITH_HEADER,
			metadata: { content_type: 'linkedin_post', scheduled_date: '2026-10-27' },
		})
		expect(preview).toMatchObject({
			kind: 'linkedin_post',
			label: 'LinkedIn post',
			details: [{ label: 'Scheduled', value: '2026-10-27' }],
		})
		expect(preview?.body.startsWith('Most agent demos')).toBe(true)
	})

	it('reads a post that has no header as it stands', () => {
		const preview = buildObjectPreview({
			content: 'Just the post.',
			metadata: { kind: 'linkedin_post' },
		})
		expect(preview?.body).toBe('Just the post.')
	})

	it('reads a post block that has no media section to the end', () => {
		const preview = buildObjectPreview({
			content: 'Account: x\n--- POST ---\nLine one\nLine two',
			metadata: { kind: 'linkedin_post' },
		})
		expect(preview?.body).toBe('Line one\nLine two')
	})

	it('says a post is empty when its block has no text', () => {
		const preview = buildObjectPreview({
			content: 'Account: x\n--- POST ---\n--- MEDIA ---\nnone',
			metadata: { kind: 'linkedin_post' },
		})
		expect(preview?.missing).toEqual(['Message'])
	})

	it('warns when a post is over the LinkedIn limit', () => {
		const preview = buildObjectPreview({
			content: `--- POST ---\n${'x'.repeat(3002)}\n--- MEDIA ---\nnone`,
			metadata: { kind: 'linkedin_post' },
		})
		expect(preview?.warnings).toEqual(['The text is 2 characters over the 3000 limit.'])
	})

	it('lets an explicit kind win over what the metadata would match', () => {
		const preview = buildObjectPreview({
			content: 'Hi',
			metadata: { kind: 'linkedin_message', to: 'Dan', content_type: 'linkedin_post' },
		})
		expect(preview?.kind).toBe('linkedin_message')
	})

	it('does not preview an object whose content type no provider declares', () => {
		expect(buildObjectPreview({ content: 'Hi', metadata: { content_type: 'article' } })).toBeNull()
	})
})

describe('content hash', () => {
	it('is unchanged for an email, so approvals already given stay valid', () => {
		const preview = buildObjectPreview({
			content: 'Hi Mette',
			metadata: { kind: 'email', to: 'mette@northwind.dk', subject: 'Thursday' },
		})
		const before = createHash('sha256')
			.update(JSON.stringify(['email', ['to:mette@northwind.dk'], 'Thursday', 'Hi Mette']))
			.digest('hex')
		expect(preview?.content_hash).toBe(before)
	})

	it('changes when the account a post is published as changes', () => {
		const hash = (account: string) =>
			buildObjectPreview({
				content: 'A post.',
				metadata: { kind: 'linkedin_post', account },
			})?.content_hash
		expect(hash('maskin_page')).not.toBe(hash('sebk_personal'))
	})

	it('changes when the Slack channel changes', () => {
		const hash = (channel: string) =>
			buildObjectPreview({
				content: 'Hi',
				metadata: { kind: 'slack_message', channel },
			})?.content_hash
		expect(hash('#modl-maskin')).not.toBe(hash('#coach-maskin'))
	})
})

describe('deliverables declarations, matching', () => {
	it('never lets two kinds claim the same metadata pairs', () => {
		const seen = new Set<string>()
		for (const { deliverable } of listDeliverableKinds()) {
			for (const pair of deliverable.alsoMatches ?? []) {
				const key = `${pair.key}=${pair.value}`
				expect(seen.has(key)).toBe(false)
				seen.add(key)
			}
		}
	})

	it('gives every kind a label, at most one subject slot and only text or recipients fields', () => {
		for (const { deliverable } of listDeliverableKinds()) {
			expect(deliverable.label).not.toBe('')
			for (const field of deliverable.fields) {
				expect(['recipients', 'text']).toContain(field.type)
			}
		}
	})

	it('declares the channels people ask for', () => {
		expect(
			listDeliverableKinds()
				.map((k) => k.deliverable.kind)
				.sort(),
		).toEqual([
			'email',
			'linkedin_connection_request',
			'linkedin_message',
			'linkedin_post',
			'slack_message',
		])
	})
})

import { describe, expect, it } from 'vitest'
import { readAttachmentIds } from '../../lib/email-attachments'
import {
	GmailSendError,
	buildMimeMessage,
	parseRecipients,
} from '../../lib/integrations/providers/gmail/send'
import { buildObjectPreview } from '../../lib/object-preview'

const base = {
	to: parseRecipients('ada@example.com'),
	subject: 'Receipt',
	body: 'Hi Ada,\n\nHere it is.',
}
const FILE_A = '3f1c2a6e-8b7d-4a55-9d0e-2b6f4c1a9e01'
const FILE_B = '7a9e4d12-0c3b-4f68-8e21-5d7c9b3a1f02'

describe('buildMimeMessage', () => {
	it('stays a single text part when there are no attachments', () => {
		const mime = buildMimeMessage(base)
		expect(mime).not.toContain('multipart')
		expect(mime).toContain('Content-Type: text/plain; charset=UTF-8')
		expect(buildMimeMessage({ ...base, attachments: [] })).toBe(mime)
	})

	it('builds multipart/mixed with the text first and each file as a base64 attachment', () => {
		const mime = buildMimeMessage({
			...base,
			attachments: [
				{
					filename: 'receipt.pdf',
					contentType: 'application/pdf',
					content: Buffer.from('%PDF-1.7 hi'),
				},
			],
		})
		const boundary = /boundary="([^"]+)"/.exec(mime)?.[1]
		expect(boundary).toBeTruthy()
		expect(mime).toContain('Content-Type: multipart/mixed')
		expect(mime).toContain(
			'Content-Disposition: attachment; filename="receipt.pdf"; filename*=UTF-8\'\'receipt.pdf',
		)
		expect(mime).toContain(Buffer.from('%PDF-1.7 hi').toString('base64'))
		expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('application/pdf'))
		expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
	})

	it('encodes a non-ASCII file name and cannot be used to smuggle a header', () => {
		const mime = buildMimeMessage({
			...base,
			attachments: [
				{
					filename: 'kvittering æø.pdf',
					contentType: 'application/pdf',
					content: Buffer.from('x'),
				},
			],
		})
		expect(mime).toContain("filename*=UTF-8''kvittering%20%C3%A6%C3%B8.pdf")
		expect(() =>
			buildMimeMessage({
				...base,
				attachments: [
					{
						filename: 'a.pdf\r\nBcc: evil@example.com',
						contentType: 'application/pdf',
						content: Buffer.from('x'),
					},
				],
			}),
		).toThrow(GmailSendError)
	})
})

describe('readAttachmentIds', () => {
	it('reads a list or a comma separated string, in order, without repeats', () => {
		expect(readAttachmentIds({ attachment_file_ids: [FILE_B, ` ${FILE_A} `, FILE_B] })).toEqual([
			FILE_B,
			FILE_A,
		])
		expect(readAttachmentIds({ attachment_file_ids: `${FILE_A}, ${FILE_B}` })).toEqual([
			FILE_A,
			FILE_B,
		])
		expect(readAttachmentIds({})).toEqual([])
	})
})

describe('email preview hash', () => {
	const draft = (ids?: unknown) =>
		buildObjectPreview({
			content: 'Hi Ada',
			metadata: {
				kind: 'email',
				to: 'ada@example.com',
				subject: 'Receipt',
				...(ids ? { attachment_file_ids: ids } : {}),
			},
		})

	it('is unchanged for an email with no files', () => {
		expect(draft()?.details).toEqual([])
	})

	it('changes when a file is added, removed or swapped', () => {
		const none = draft()?.content_hash
		const one = draft([FILE_A])?.content_hash
		const swapped = draft([FILE_B])?.content_hash
		expect(new Set([none, one, swapped, draft([FILE_A, FILE_B])?.content_hash]).size).toBe(4)
		expect(draft(FILE_A)?.content_hash).toBe(one)
	})
})

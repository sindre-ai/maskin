import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GMAIL_ATTACHMENT_MAX_BYTES,
	GmailAttachmentError,
	fetchGmailAttachment,
	sanitizeAttachmentName,
} from '../../../../lib/integrations/providers/gmail/attachment'

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0xfb, 0x00, 0x2d])

/** A message with the receipt nested one level down, the way a mail with a text body is built. */
const message = (part: Record<string, unknown> = {}) => ({
	payload: {
		mimeType: 'multipart/mixed',
		body: { size: 0 },
		parts: [
			{ mimeType: 'text/plain', filename: '', body: { size: 5, data: 'aGVsbG8' } },
			{
				mimeType: 'application/pdf',
				filename: 'receipt-4711.pdf',
				body: { attachmentId: 'ATT-1', size: BYTES.length },
				...part,
			},
		],
	},
})

/** Two attachments, the way Gmail lists them: partId is stable, the attachment ids are per fetch. */
const twoAttachments = () => ({
	payload: {
		mimeType: 'multipart/mixed',
		parts: [
			{ partId: '0', mimeType: 'text/plain', filename: '', body: { size: 5, data: 'aGVsbG8' } },
			{
				partId: '1',
				mimeType: 'application/pdf',
				filename: 'invoice.pdf',
				body: { attachmentId: 'FRESH-1', size: BYTES.length },
			},
			{
				partId: '2',
				mimeType: 'application/pdf',
				filename: 'receipt.pdf',
				body: { attachmentId: 'FRESH-2', size: BYTES.length },
			},
		],
	},
})

const attachmentData = (bytes: Buffer = BYTES) => ({
	size: bytes.length,
	data: bytes.toString('base64url'),
})

const failure = async (promise: Promise<unknown>) => {
	const err = await promise.then(
		() => null,
		(e) => e,
	)
	expect(err).toBeInstanceOf(GmailAttachmentError)
	return err as GmailAttachmentError
}

describe('fetchGmailAttachment', () => {
	it('decodes the base64url bytes and takes name and type from the message part', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, message()))
			.mockResolvedValueOnce(json(200, attachmentData()))

		const out = await fetchGmailAttachment('token', 'msg1', 'ATT-1')

		expect(out.bytes.equals(BYTES)).toBe(true)
		expect(out.name).toBe('receipt-4711.pdf')
		expect(out.mimeType).toBe('application/pdf')
		const [messageUrl, messageInit] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(messageUrl).toContain('/users/me/messages/msg1?')
		expect(messageInit.headers).toEqual({ Authorization: 'Bearer token' })
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg1/attachments/ATT-1',
		)
	})

	it('finds the part through nested multiparts', async () => {
		fetchMock
			.mockResolvedValueOnce(
				json(200, {
					payload: {
						mimeType: 'multipart/mixed',
						parts: [
							{
								mimeType: 'multipart/related',
								parts: [
									{
										mimeType: 'image/png',
										filename: 'logo.png',
										body: { attachmentId: 'ATT-1', size: 9 },
									},
								],
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(json(200, attachmentData()))

		const out = await fetchGmailAttachment('token', 'msg1', 'ATT-1')
		expect(out.name).toBe('logo.png')
		expect(out.mimeType).toBe('image/png')
	})

	it('refuses an attachment id the message does not carry, without downloading anything', async () => {
		fetchMock.mockResolvedValueOnce(json(200, twoAttachments()))

		const err = await failure(fetchGmailAttachment('token', 'msg1', 'OTHER'))

		expect(err.code).toBe('NOT_FOUND')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('matches by part id when the message now carries a different attachment id than the caller read', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, twoAttachments()))
			.mockResolvedValueOnce(json(200, attachmentData()))

		const out = await fetchGmailAttachment('token', 'msg1', 'STALE-FROM-THE-READ-TOOL', '2')

		expect(out.name).toBe('receipt.pdf')
		// The bytes are fetched with the id from our own fetch, not the caller's stale one.
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg1/attachments/FRESH-2',
		)
	})

	it('uses the only attachment when neither the part id nor the attachment id matches', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, message({ partId: '1' })))
			.mockResolvedValueOnce(json(200, attachmentData()))

		const out = await fetchGmailAttachment('token', 'msg1', 'STALE-FROM-THE-READ-TOOL')

		expect(out.name).toBe('receipt-4711.pdf')
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg1/attachments/ATT-1',
		)
	})

	it('refuses a part id no attachment has when the message has several attachments', async () => {
		fetchMock.mockResolvedValueOnce(json(200, twoAttachments()))

		const err = await failure(fetchGmailAttachment('token', 'msg1', 'STALE', '9'))

		expect(err.code).toBe('NOT_FOUND')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses a part id that is not a Gmail part id', async () => {
		const err = await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1', '1/../x'))
		expect(err.code).toBe('INVALID_INPUT')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a message that is not in the connected account', async () => {
		fetchMock.mockResolvedValueOnce(
			json(404, { error: { message: 'Requested entity was not found.' } }),
		)

		const err = await failure(fetchGmailAttachment('token', 'someone-elses', 'ATT-1'))

		expect(err.code).toBe('NOT_FOUND')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses an attachment over the limit by its declared size, before downloading it', async () => {
		fetchMock.mockResolvedValueOnce(
			json(200, message({ body: { attachmentId: 'ATT-1', size: GMAIL_ATTACHMENT_MAX_BYTES + 1 } })),
		)

		const err = await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))

		expect(err.code).toBe('TOO_LARGE')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses bytes over the limit even when the declared size was small', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, message()))
			.mockResolvedValueOnce(
				json(200, attachmentData(Buffer.alloc(GMAIL_ATTACHMENT_MAX_BYTES + 1))),
			)

		const err = await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))

		expect(err.code).toBe('TOO_LARGE')
	})

	it('never lets an id add a path segment or a query to the Gmail URL', async () => {
		for (const [messageId, attachmentId] of [
			['../drafts', 'ATT-1'],
			['msg1?alt=media', 'ATT-1'],
			['msg1', 'a/../../b'],
			['msg1', 'a?x=1'],
		] as const) {
			const err = await failure(fetchGmailAttachment('token', messageId, attachmentId))
			expect(err.code).toBe('INVALID_INPUT')
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('falls back to a plain name and a generic type when the part has none that is usable', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, message({ filename: '', mimeType: 'not a type' })))
			.mockResolvedValueOnce(json(200, attachmentData()))

		const out = await fetchGmailAttachment('token', 'msg1', 'ATT-1')

		expect(out.name).toBe('attachment')
		expect(out.mimeType).toBe('application/octet-stream')
	})

	it('words a rejected login and a missing scope as a reconnect', async () => {
		fetchMock.mockResolvedValueOnce(json(401, { error: { message: 'Invalid Credentials' } }))
		expect((await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))).code).toBe(
			'RECONSENT_REQUIRED',
		)

		fetchMock.mockResolvedValueOnce(json(403, { error: { message: 'Insufficient Permission' } }))
		expect((await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))).code).toBe(
			'INSUFFICIENT_SCOPE',
		)
	})

	it('reports a dropped connection and a server error as unavailable', async () => {
		fetchMock.mockRejectedValueOnce(new Error('socket hang up'))
		expect((await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))).code).toBe('UNAVAILABLE')

		fetchMock.mockResolvedValueOnce(json(503, {}))
		expect((await failure(fetchGmailAttachment('token', 'msg1', 'ATT-1'))).code).toBe('UNAVAILABLE')
	})
})

describe('sanitizeAttachmentName', () => {
	it('drops path parts, control characters and leading dots', () => {
		expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd')
		expect(sanitizeAttachmentName('C:\\Users\\me\\receipt.pdf')).toBe('receipt.pdf')
		expect(sanitizeAttachmentName('re\r\nceipt\u0000.pdf')).toBe('re ceipt .pdf')
		expect(sanitizeAttachmentName('.hidden.pdf')).toBe('hidden.pdf')
	})

	it('keeps a normal name, including non-ASCII letters', () => {
		expect(sanitizeAttachmentName('Kvittering æøå 2026.pdf')).toBe('Kvittering æøå 2026.pdf')
	})

	it('falls back for an empty name and caps a very long one', () => {
		expect(sanitizeAttachmentName(undefined)).toBe('attachment')
		expect(sanitizeAttachmentName('///')).toBe('attachment')
		expect(sanitizeAttachmentName('a'.repeat(400))).toHaveLength(255)
	})
})

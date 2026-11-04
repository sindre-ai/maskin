import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GmailSendError,
	buildMimeMessage,
	parseRecipients,
	sendEmail,
	splitSubject,
} from '../../../../lib/integrations/providers/gmail/send'

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

const ADA = { address: 'ada@example.com', name: null }

describe('parseRecipients', () => {
	it('reads a bare address and a named one', () => {
		expect(parseRecipients('Ada@Example.com, Mette Holm <mette@northwind.dk>')).toEqual([
			{ address: 'ada@example.com', name: null },
			{ address: 'mette@northwind.dk', name: 'Mette Holm' },
		])
	})

	it('refuses a display name with no address, as an approval card allows for "to"', () => {
		expect(() => parseRecipients('Mette Holm, Northwind')).toThrow(/not an email address/)
	})

	it.each([
		['a line break that would add a header', 'ada@example.com\r\nBcc: boss@example.com'],
		['a bare line feed', 'ada@example.com\nBcc: x@example.com'],
		['a missing domain dot', 'ada@localhost'],
		['spaces in the address', 'ada lovelace@example.com'],
		['a quote in the address', 'a"da@example.com'],
	])('refuses %s', (_label, input) => {
		expect(() => parseRecipients(input)).toThrow(GmailSendError)
	})

	it('refuses an empty field', () => {
		expect(() => parseRecipients('  ,  ')).toThrow(/no email address/)
	})
})

describe('buildMimeMessage', () => {
	it('builds headers, and a UTF-8 base64 body that decodes to the original text', () => {
		const mime = buildMimeMessage({
			to: [ADA],
			cc: [{ address: 'noor@example.com', name: 'Noor' }],
			subject: 'Hello',
			body: 'Line one\nLine two',
		})

		expect(mime).toContain('To: ada@example.com\r\n')
		expect(mime).toContain('Cc: Noor <noor@example.com>\r\n')
		expect(mime).toContain('Subject: Hello\r\n')
		expect(mime).toContain('Content-Type: text/plain; charset=UTF-8')
		const body = mime.split('\r\n\r\n')[1] ?? ''
		expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
			'Line one\r\nLine two',
		)
	})

	it('encodes a non-ASCII subject and name as RFC 2047 words', () => {
		const mime = buildMimeMessage({
			to: [{ address: 'soren@example.dk', name: 'Søren Østergård' }],
			subject: 'Opfølgning på mødet',
			body: 'Hej',
		})

		const subject = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(mime)
		expect(Buffer.from(subject?.[1] ?? '', 'base64').toString('utf8')).toBe('Opfølgning på mødet')
		expect(mime).toMatch(/To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <soren@example\.dk>/)
	})

	it('refuses a subject with a line break', () => {
		expect(() =>
			buildMimeMessage({ to: [ADA], subject: 'Hi\r\nBcc: x@example.com', body: 'x' }),
		).toThrow(/line break/)
	})

	it('refuses more recipients than the limit', () => {
		const many = Array.from({ length: 21 }, (_, i) => ({
			address: `p${i}@example.com`,
			name: null,
		}))
		expect(() => buildMimeMessage({ to: many, subject: 's', body: 'b' })).toThrow(/At most 20/)
	})
})

describe('sendEmail', () => {
	const email = { to: [ADA], subject: 'Hi', body: 'Hello' }

	it('posts the base64url message with the bearer token and returns the ids', async () => {
		fetchMock.mockResolvedValueOnce(json(200, { id: 'sent-1', threadId: 't1' }))

		const sent = await sendEmail('tok', email)

		expect(sent).toEqual({ messageId: 'sent-1', threadId: 't1' })
		const [url, init] = fetchMock.mock.calls[0]
		expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
		expect(init.headers.Authorization).toBe('Bearer tok')
		const raw = JSON.parse(init.body).raw as string
		expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('To: ada@example.com')
	})

	it('treats a 4xx as a refusal: nothing was sent', async () => {
		fetchMock.mockResolvedValueOnce(json(400, { error: { message: 'Invalid To header' } }))

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'REJECTED' })
	})

	it('treats a 5xx as an unknown outcome and does not retry', async () => {
		fetchMock.mockResolvedValueOnce(json(503, { error: { message: 'Backend Error' } }))

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('treats a dropped connection as an unknown outcome', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('asks for a reconnect on 401', async () => {
		fetchMock.mockResolvedValueOnce(json(401, { error: { message: 'Invalid Credentials' } }))

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'RECONSENT_REQUIRED' })
	})

	it('names the missing permission on a scope error', async () => {
		fetchMock.mockResolvedValueOnce(
			json(403, { error: { message: 'Request had insufficient authentication scopes.' } }),
		)

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
	})

	it('treats a success with no id as an unknown outcome', async () => {
		fetchMock.mockResolvedValueOnce(json(200, {}))

		await expect(sendEmail('tok', email)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' })
	})
})

describe('splitSubject', () => {
	it('reads the subject from the first line and the body after the blank line', () => {
		expect(splitSubject('Subject: Following up\n\nHi Mette,\nThe note.')).toEqual({
			subject: 'Following up',
			body: 'Hi Mette,\nThe note.',
		})
	})

	it('is not fussy about case, spacing, leading blank lines or Windows line breaks', () => {
		expect(splitSubject('\n  SUBJECT:   Hello  \r\n\r\nBody')).toEqual({
			subject: 'Hello',
			body: 'Body',
		})
	})

	it('keeps a later "Subject:" line in the body', () => {
		expect(splitSubject('Subject: One\n\nSubject: Two')?.body).toBe('Subject: Two')
	})

	it.each([
		['no subject line', 'Hi Ada, nothing else'],
		['a subject with no body', 'Subject: Hello'],
		['an empty subject', 'Subject:   \n\nBody'],
		['a body of only blank space', 'Subject: Hello\n\n   \n'],
	])('returns null for %s', (_label, text) => {
		expect(splitSubject(text)).toBeNull()
	})
})

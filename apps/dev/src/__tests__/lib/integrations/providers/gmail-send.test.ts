import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GmailSendError,
	getDraftSummary,
	listDraftSummaries,
	sendDraft,
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

function draftBody(messageId: string) {
	return {
		id: 'draft-1',
		message: {
			id: messageId,
			threadId: 'thread-1',
			snippet: 'Hi there',
			payload: {
				headers: [
					{ name: 'To', value: 'ada@example.com' },
					{ name: 'subject', value: 'Intro' },
				],
			},
		},
	}
}

describe('getDraftSummary', () => {
	it('returns recipients, subject and the message id used as the draft version', async () => {
		fetchMock.mockResolvedValueOnce(json(200, draftBody('m1')))

		const draft = await getDraftSummary('tok', 'draft-1')

		expect(draft).toEqual({
			draftId: 'draft-1',
			messageId: 'm1',
			threadId: 'thread-1',
			to: 'ada@example.com',
			cc: '',
			subject: 'Intro',
			snippet: 'Hi there',
		})
		const [url, init] = fetchMock.mock.calls[0]
		expect(String(url)).toContain('/drafts/draft-1?')
		expect(init.headers.Authorization).toBe('Bearer tok')
	})

	it('reports a missing draft as DRAFT_NOT_FOUND', async () => {
		fetchMock.mockResolvedValueOnce(
			json(404, { error: { message: 'Requested entity was not found.' } }),
		)

		await expect(getDraftSummary('tok', 'gone')).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' })
	})
})

describe('sendDraft', () => {
	it('sends when the draft is still the version the caller saw', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, draftBody('m1')))
			.mockResolvedValueOnce(json(200, { id: 'sent-1', threadId: 'thread-1' }))

		const sent = await sendDraft('tok', 'draft-1', 'm1')

		expect(sent).toEqual({ messageId: 'sent-1', threadId: 'thread-1' })
		const [url, init] = fetchMock.mock.calls[1]
		expect(String(url)).toMatch(/\/drafts\/send$/)
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body)).toEqual({ id: 'draft-1' })
	})

	it('refuses to send a draft that was edited after it was shown', async () => {
		fetchMock.mockResolvedValueOnce(json(200, draftBody('m2')))

		await expect(sendDraft('tok', 'draft-1', 'm1')).rejects.toMatchObject({ code: 'DRAFT_CHANGED' })
		// Only the read happened: nothing was sent.
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('does not retry after a Gmail server error', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, draftBody('m1')))
			.mockResolvedValueOnce(json(503, { error: { message: 'Backend Error' } }))

		await expect(sendDraft('tok', 'draft-1', 'm1')).rejects.toMatchObject({
			code: 'PROVIDER_ERROR',
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('asks for a reconnect when Gmail rejects the token', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, draftBody('m1')))
			.mockResolvedValueOnce(json(401, { error: { message: 'Invalid Credentials' } }))

		await expect(sendDraft('tok', 'draft-1', 'm1')).rejects.toMatchObject({
			code: 'RECONSENT_REQUIRED',
		})
	})

	it('names the missing scope when Gmail refuses with insufficient permissions', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, draftBody('m1')))
			.mockResolvedValueOnce(
				json(403, { error: { message: 'Request had insufficient authentication scopes.' } }),
			)

		const err = await sendDraft('tok', 'draft-1', 'm1').catch((e) => e)
		expect(err).toBeInstanceOf(GmailSendError)
		expect(err.code).toBe('INSUFFICIENT_SCOPE')
	})
})

describe('listDraftSummaries', () => {
	it('reads each listed draft and skips one that vanished meanwhile', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, { drafts: [{ id: 'draft-1' }, { id: 'gone' }] }))
			.mockResolvedValueOnce(json(200, draftBody('m1')))
			.mockResolvedValueOnce(json(404, { error: { message: 'Requested entity was not found.' } }))

		const drafts = await listDraftSummaries('tok')

		expect(drafts.map((d) => d.draftId)).toEqual(['draft-1'])
		expect(String(fetchMock.mock.calls[0][0])).toContain('maxResults=20')
	})

	it('returns an empty list when there are no drafts', async () => {
		fetchMock.mockResolvedValueOnce(json(200, {}))

		expect(await listDraftSummaries('tok')).toEqual([])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

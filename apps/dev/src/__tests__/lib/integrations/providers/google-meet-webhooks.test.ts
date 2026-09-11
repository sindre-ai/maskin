import { describe, expect, it } from 'vitest'
import {
	extractMeetDeliveryId,
	extractPeopleId,
	meetEventNormalizer,
} from '../../../../lib/integrations/providers/google-meet/webhooks'

function buildEnvelope(inner: unknown, messageId = 'm-1') {
	return {
		message: {
			data: Buffer.from(JSON.stringify(inner), 'utf-8').toString('base64'),
			messageId,
		},
		subscription: 'projects/proj/subscriptions/sub-1',
	}
}

describe('meetEventNormalizer', () => {
	it('routes a conference.ended push to the placeholder people-id', () => {
		const envelope = buildEnvelope({
			eventType: 'google.workspace.meet.conference.v2.ended',
			resource: { name: '//cloudidentity.googleapis.com/users/PID-123' },
		})
		const normalized = meetEventNormalizer(envelope, {})
		expect(normalized).not.toBeNull()
		expect(normalized?.installationId).toBe('PID-123')
		expect(normalized?.action).toBe('conference_ended')
		expect(String(normalized?.data.eventType ?? '')).toContain('conference.v2.ended')
		expect(normalized?.data.messageId).toBe('m-1')
	})

	it('recognises transcript.ready push', () => {
		const envelope = buildEnvelope({
			eventType: 'google.workspace.meet.transcript.v2.fileGenerated',
			resource: { name: '//cloudidentity.googleapis.com/users/PID-XYZ' },
			conferenceRecord: 'conferenceRecords/abc',
		})
		const normalized = meetEventNormalizer(envelope, {})
		expect(normalized?.action).toBe('transcript_ready')
		expect(normalized?.data.conferenceRecordName).toBe('conferenceRecords/abc')
	})

	it('returns null when the envelope is not a Pub/Sub push', () => {
		expect(meetEventNormalizer({ nope: true }, {})).toBeNull()
	})

	it('returns null when message.data is not base64 JSON', () => {
		expect(
			meetEventNormalizer({ message: { data: 'not-b64!!!', messageId: 'x' } }, {}),
		).toBeNull()
	})

	it('returns null when no People-id can be extracted', () => {
		const envelope = buildEnvelope({
			eventType: 'google.workspace.meet.conference.v2.ended',
		})
		expect(meetEventNormalizer(envelope, {})).toBeNull()
	})
})

describe('extractPeopleId', () => {
	it('parses the People-id from a cloudidentity user reference', () => {
		expect(
			extractPeopleId({ resource: { name: '//cloudidentity.googleapis.com/users/pid-42' } }),
		).toBe('pid-42')
	})

	it('falls back to Pub/Sub attributes when the resource ref is absent', () => {
		expect(extractPeopleId({}, { userId: 'attr-uid' })).toBe('attr-uid')
	})

	it('returns null when the payload carries neither', () => {
		expect(extractPeopleId({})).toBeNull()
	})
})

describe('extractMeetDeliveryId', () => {
	it('returns the Pub/Sub messageId', () => {
		expect(
			extractMeetDeliveryId({
				message: { data: 'x', messageId: 'msg-9' },
			}),
		).toBe('msg-9')
	})

	it('returns null when the envelope is malformed', () => {
		expect(extractMeetDeliveryId({ nope: true })).toBeNull()
	})
})

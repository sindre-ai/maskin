import { describe, expect, it } from 'vitest'
import { LinkedInIntegrationError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import {
	POST_ID_ACCEPTED_FORMS,
	parsePostId,
	withAcceptedForms,
} from '../../../../../lib/integrations/providers/linkedin-unipile/post-id'

const ACTIVITY_ID = '7519434747178049536'

describe('parsePostId', () => {
	it('reads a bare activity number', () => {
		expect(parsePostId(ACTIVITY_ID)).toEqual({ kind: 'activity', activityId: ACTIVITY_ID })
	})

	it('reads an urn:li:activity URN, trimming whitespace', () => {
		expect(parsePostId(`  urn:li:activity:${ACTIVITY_ID} `)).toEqual({
			kind: 'activity',
			activityId: ACTIVITY_ID,
		})
	})

	it.each([
		[
			'a /posts/ URL',
			`https://www.linkedin.com/posts/satyanadella_some-title-activity-${ACTIVITY_ID}-AbCd`,
		],
		[
			'a /posts/ URL with a query string',
			`https://www.linkedin.com/posts/satyanadella_some-title-activity-${ACTIVITY_ID}-AbCd?utm_source=share&utm_medium=member_desktop`,
		],
		['a /feed/update/ URL', `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY_ID}/`],
		[
			'a /feed/update/ URL with the colons percent-encoded',
			`https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${ACTIVITY_ID}`,
		],
		[
			'a URL with no scheme',
			`linkedin.com/posts/satyanadella_some-title-activity-${ACTIVITY_ID}-AbCd`,
		],
	])('takes the activity number from %s', (_label, url) => {
		expect(parsePostId(url)).toEqual({ kind: 'activity', activityId: ACTIVITY_ID })
	})

	it('leaves the id list_user_posts returned untouched', () => {
		const opaque = 'dXJuOmxpOmFjdGl2aXR5Ojc1MTk0MzQ3NDcxNzgwNDk1MzY'
		expect(parsePostId(opaque)).toEqual({ kind: 'opaque', id: opaque })
	})

	it('rejects a URL with no activity number and names the accepted forms', () => {
		expect(() => parsePostId('https://www.linkedin.com/in/satyanadella/')).toThrow(
			LinkedInIntegrationError,
		)
		expect(() => parsePostId('https://www.linkedin.com/in/satyanadella/')).toThrow(
			POST_ID_ACCEPTED_FORMS,
		)
	})

	it('rejects a URN that is not an activity URN and names the accepted forms', () => {
		const attempt = () => parsePostId('urn:li:ugcPost:7519434747178049536')
		expect(attempt).toThrow(LinkedInIntegrationError)
		expect(attempt).toThrow(POST_ID_ACCEPTED_FORMS)
	})
})

describe('withAcceptedForms', () => {
	it('adds the accepted forms to an upstream INVALID_INPUT and keeps the code', () => {
		const out = withAcceptedForms(
			new LinkedInIntegrationError('INVALID_INPUT', 'Invalid Post ID', { httpStatus: 400 }),
		)
		expect(out).toBeInstanceOf(LinkedInIntegrationError)
		expect((out as LinkedInIntegrationError).code).toBe('INVALID_INPUT')
		expect((out as LinkedInIntegrationError).message).toContain('Invalid Post ID')
		expect((out as LinkedInIntegrationError).message).toContain(POST_ID_ACCEPTED_FORMS)
	})

	it('passes any other error through unchanged', () => {
		const other = new LinkedInIntegrationError('LINKEDIN_UNAVAILABLE', 'down')
		expect(withAcceptedForms(other)).toBe(other)
		const plain = new Error('boom')
		expect(withAcceptedForms(plain)).toBe(plain)
	})
})

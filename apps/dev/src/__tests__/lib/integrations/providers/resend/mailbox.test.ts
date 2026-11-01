import { describe, expect, it } from 'vitest'
import { normalizeMailbox } from '../../../../../lib/integrations/providers/resend/mailbox'

describe('normalizeMailbox', () => {
	it('lowercases and trims one plain address', () => {
		expect(normalizeMailbox('  Developer@Maskin.io ')).toBe('developer@maskin.io')
		expect(normalizeMailbox('solveig+outreach@mail.maskin.io')).toBe(
			'solveig+outreach@mail.maskin.io',
		)
	})

	it.each([
		'Developer <developer@maskin.io>',
		'a@maskin.io, b@maskin.io',
		'developer@maskin.io\nbcc: eve@example.com',
		'"quoted"@maskin.io',
		'developer@localhost',
		'no-at-sign',
		'',
		'@maskin.io',
	])('rejects %j', (input) => {
		expect(normalizeMailbox(input)).toBeNull()
	})
})

import { describe, expect, it } from 'vitest'
import { isRiskyTool, isYes } from '../../services/voice-write-gate'

describe('isYes', () => {
	it.each([
		'yes',
		'Yes.',
		'yeah',
		'go ahead',
		'Do it!',
		'sure',
		'confirm',
		"That's right",
		'that is right',
		'yes, do it',
		'okay go ahead',
	])('takes "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(true)
	})

	it.each([
		'no',
		'no wait',
		'yes but wait',
		'yes?',
		'can you repeat that',
		'yes please go ahead and do that right now',
		'yesterday',
		'not yet',
		"don't do it",
		'',
	])('does not take "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(false)
	})
})

describe('isRiskyTool', () => {
	it.each(['gmail_send_email', 'delete_object', 'desktop_run', 'update_actor', 'gmail__send'])(
		'puts %s in the risky class',
		(name) => {
			expect(isRiskyTool(name)).toBe(true)
		},
	)

	it.each(['create_comment', 'update_objects', 'create_objects'])(
		'leaves %s as an ordinary write',
		(name) => {
			expect(isRiskyTool(name)).toBe(false)
		},
	)
})

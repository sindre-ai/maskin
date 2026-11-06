import { greetingFor } from '@/routes/_authed/$workspaceId/index'
import { describe, expect, it } from 'vitest'

function at(hour: number): Date {
	return new Date(2026, 10, 1, hour, 30)
}

describe('greetingFor', () => {
	it('says Good night before 05:00', () => {
		expect(greetingFor('Ada Lovelace', at(0))).toBe('Good night, Ada')
		expect(greetingFor(undefined, at(4))).toBe('Good night')
	})

	it('switches to morning at 05:00, afternoon at 12:00, evening at 18:00', () => {
		expect(greetingFor(undefined, at(5))).toBe('Good morning')
		expect(greetingFor(undefined, at(12))).toBe('Good afternoon')
		expect(greetingFor(undefined, at(18))).toBe('Good evening')
	})
})

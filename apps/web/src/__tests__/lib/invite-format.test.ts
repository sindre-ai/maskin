import {
	formatInviteExpiry,
	formatRetryAfter,
	inviteRoleLabel,
	isValidInviteEmail,
} from '@/lib/invite-format'
import { describe, expect, it } from 'vitest'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const inMs = (ms: number) => new Date(NOW + ms).toISOString()

describe('formatInviteExpiry', () => {
	it('returns null while a day or more remains', () => {
		expect(formatInviteExpiry(inMs(24 * 60 * 60 * 1000), NOW)).toBeNull()
		expect(formatInviteExpiry(inMs(6 * 24 * 60 * 60 * 1000), NOW)).toBeNull()
	})

	it('shows whole hours once under a day remains', () => {
		expect(formatInviteExpiry(inMs(4.5 * 60 * 60 * 1000), NOW)).toBe('expires in 4h')
		expect(formatInviteExpiry(inMs(23 * 60 * 60 * 1000 + 59 * 60 * 1000), NOW)).toBe(
			'expires in 23h',
		)
	})

	it('shows minutes under an hour, never less than 1m', () => {
		expect(formatInviteExpiry(inMs(35 * 60 * 1000), NOW)).toBe('expires in 35m')
		expect(formatInviteExpiry(inMs(5 * 1000), NOW)).toBe('expires in 1m')
	})
})

describe('formatRetryAfter', () => {
	it('rounds to hours when an hour or more', () => {
		expect(formatRetryAfter(14400)).toBe('about 4 hours')
		expect(formatRetryAfter(3600)).toBe('about 1 hour')
	})

	it('uses minutes under an hour', () => {
		expect(formatRetryAfter(60)).toBe('about 1 minute')
		expect(formatRetryAfter(900)).toBe('about 15 minutes')
	})

	it('returns null when the server sent no usable value', () => {
		expect(formatRetryAfter(undefined)).toBeNull()
		expect(formatRetryAfter(0)).toBeNull()
	})
})

describe('isValidInviteEmail', () => {
	it('accepts a plain address with surrounding whitespace', () => {
		expect(isValidInviteEmail('  ada@example.com ')).toBe(true)
	})

	it('rejects addresses without a domain dot or with spaces', () => {
		expect(isValidInviteEmail('ada@example')).toBe(false)
		expect(isValidInviteEmail('ada lovelace@example.com')).toBe(false)
		expect(isValidInviteEmail('')).toBe(false)
	})
})

describe('inviteRoleLabel', () => {
	it('capitalises the role', () => {
		expect(inviteRoleLabel('member')).toBe('Member')
		expect(inviteRoleLabel('viewer')).toBe('Viewer')
	})
})

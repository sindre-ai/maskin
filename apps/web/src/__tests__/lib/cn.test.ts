import { cn } from '@/lib/cn'
import { describe, expect, it } from 'vitest'

describe('cn', () => {
	it('merges multiple class strings', () => {
		expect(cn('foo', 'bar')).toBe('foo bar')
	})

	it('handles conditional classes', () => {
		expect(cn('base', false && 'hidden', 'visible')).toBe('base visible')
	})

	it('handles undefined and null', () => {
		expect(cn('base', undefined, null, 'end')).toBe('base end')
	})

	it('resolves Tailwind conflicts (last wins)', () => {
		expect(cn('p-2', 'p-4')).toBe('p-4')
	})

	it('resolves conflicting text colors', () => {
		expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500')
	})

	it('returns empty string for no input', () => {
		expect(cn()).toBe('')
	})
})

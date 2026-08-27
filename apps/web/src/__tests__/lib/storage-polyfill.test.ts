import { describe, expect, it } from 'vitest'
import { installStoragePolyfill } from '../setup'

describe('installStoragePolyfill', () => {
	it('installs a working spec-shaped Storage when localStorage is missing', () => {
		const target: { localStorage?: Storage; sessionStorage?: Storage } = {}

		installStoragePolyfill(target)

		expect(target.localStorage).toBeDefined()
		expect(target.sessionStorage).toBeDefined()

		const storage = target.localStorage as Storage
		expect(storage.length).toBe(0)
		storage.setItem('a', '1')
		storage.setItem('b', '2')
		expect(storage.length).toBe(2)
		expect(storage.getItem('a')).toBe('1')
		expect(storage.key(0)).toBe('a')
		storage.removeItem('a')
		expect(storage.getItem('a')).toBeNull()
		expect(storage.length).toBe(1)
		storage.clear()
		expect(storage.length).toBe(0)
	})

	it('does not override an already-present localStorage', () => {
		const existing = {} as Storage
		const target: { localStorage?: Storage; sessionStorage?: Storage } = {
			localStorage: existing,
		}

		installStoragePolyfill(target)

		expect(target.localStorage).toBe(existing)
	})
})

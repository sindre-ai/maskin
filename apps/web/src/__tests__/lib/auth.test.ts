import {
	clearAuth,
	getApiKey,
	getStoredActor,
	isAuthenticated,
	setApiKey,
	setStoredActor,
} from '@/lib/auth'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
	localStorage.clear()
})

describe('getApiKey', () => {
	it('returns null when no key stored', () => {
		expect(getApiKey()).toBeNull()
	})

	it('returns stored key', () => {
		localStorage.setItem('ai-native-api-key', 'ank_test123')
		expect(getApiKey()).toBe('ank_test123')
	})
})

describe('setApiKey', () => {
	it('stores key in localStorage', () => {
		setApiKey('ank_mykey')
		expect(localStorage.getItem('ai-native-api-key')).toBe('ank_mykey')
	})
})

describe('getStoredActor', () => {
	it('returns null when no actor stored', () => {
		expect(getStoredActor()).toBeNull()
	})

	it('returns parsed actor', () => {
		const actor = { id: '1', name: 'Alice', type: 'human', email: 'a@b.com' }
		localStorage.setItem('ai-native-actor', JSON.stringify(actor))
		expect(getStoredActor()).toEqual(actor)
	})

	it('returns null for invalid JSON', () => {
		localStorage.setItem('ai-native-actor', 'not-json')
		expect(getStoredActor()).toBeNull()
	})
})

describe('setStoredActor', () => {
	it('stores serialized actor', () => {
		const actor = { id: '1', name: 'Bob', type: 'agent', email: null }
		setStoredActor(actor)
		expect(JSON.parse(localStorage.getItem('ai-native-actor') ?? '{}')).toEqual(actor)
	})
})

describe('clearAuth', () => {
	it('removes both keys from localStorage', () => {
		setApiKey('ank_key')
		setStoredActor({ id: '1', name: 'A', type: 'human', email: null })
		clearAuth()
		expect(getApiKey()).toBeNull()
		expect(getStoredActor()).toBeNull()
	})
})

describe('isAuthenticated', () => {
	it('returns false when no key', () => {
		expect(isAuthenticated()).toBe(false)
	})

	it('returns true when key exists', () => {
		setApiKey('ank_key')
		expect(isAuthenticated()).toBe(true)
	})
})

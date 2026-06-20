import { clearComposerDraft, getComposerDraft, setComposerDraft } from '@/lib/composer-drafts'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
	localStorage.clear()
})

describe('getComposerDraft', () => {
	it('returns empty string when nothing stored', () => {
		expect(getComposerDraft('ws-1', 'conv-1')).toBe('')
	})

	it('returns the stored draft', () => {
		localStorage.setItem('maskin-composer-draft:ws-1:conv-1', 'half-typed message')
		expect(getComposerDraft('ws-1', 'conv-1')).toBe('half-typed message')
	})

	it('scopes by workspace + conversation', () => {
		localStorage.setItem('maskin-composer-draft:ws-1:conv-1', 'A')
		localStorage.setItem('maskin-composer-draft:ws-1:conv-2', 'B')
		localStorage.setItem('maskin-composer-draft:ws-2:conv-1', 'C')
		expect(getComposerDraft('ws-1', 'conv-1')).toBe('A')
		expect(getComposerDraft('ws-1', 'conv-2')).toBe('B')
		expect(getComposerDraft('ws-2', 'conv-1')).toBe('C')
	})
})

describe('setComposerDraft', () => {
	it('writes the draft under the namespaced key', () => {
		setComposerDraft('ws-1', 'conv-1', 'hello')
		expect(localStorage.getItem('maskin-composer-draft:ws-1:conv-1')).toBe('hello')
	})

	it('removes the entry when value is empty', () => {
		localStorage.setItem('maskin-composer-draft:ws-1:conv-1', 'old')
		setComposerDraft('ws-1', 'conv-1', '')
		expect(localStorage.getItem('maskin-composer-draft:ws-1:conv-1')).toBeNull()
	})

	it('overwrites a prior draft for the same key', () => {
		setComposerDraft('ws-1', 'conv-1', 'first')
		setComposerDraft('ws-1', 'conv-1', 'second')
		expect(localStorage.getItem('maskin-composer-draft:ws-1:conv-1')).toBe('second')
	})
})

describe('clearComposerDraft', () => {
	it('removes the draft for the key', () => {
		localStorage.setItem('maskin-composer-draft:ws-1:conv-1', 'gone')
		clearComposerDraft('ws-1', 'conv-1')
		expect(localStorage.getItem('maskin-composer-draft:ws-1:conv-1')).toBeNull()
	})

	it('leaves other drafts untouched', () => {
		localStorage.setItem('maskin-composer-draft:ws-1:conv-1', 'A')
		localStorage.setItem('maskin-composer-draft:ws-1:conv-2', 'B')
		clearComposerDraft('ws-1', 'conv-1')
		expect(localStorage.getItem('maskin-composer-draft:ws-1:conv-2')).toBe('B')
	})
})

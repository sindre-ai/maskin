import {
	DEFAULT_CHAT_LIST_VIEW,
	getStoredChatListView,
	persistChatListView,
} from '@/lib/chat-list-view'
import { beforeEach, describe, expect, it } from 'vitest'

describe('chat list view storage', () => {
	beforeEach(() => localStorage.clear())

	it('defaults to Agents when nothing is stored', () => {
		expect(getStoredChatListView('actor-1')).toBe(DEFAULT_CHAT_LIST_VIEW)
		expect(DEFAULT_CHAT_LIST_VIEW).toBe('agents')
	})

	it('remembers the choice per person', () => {
		persistChatListView('actor-1', 'recent')
		expect(getStoredChatListView('actor-1')).toBe('recent')
		expect(getStoredChatListView('actor-2')).toBe('agents')
	})

	it('ignores a stored value it does not know', () => {
		localStorage.setItem('maskin-chat-list-view:actor-1', 'grid')
		expect(getStoredChatListView('actor-1')).toBe('agents')
	})
})

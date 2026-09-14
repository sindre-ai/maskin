import {
	MENTION_TRIGGER_RE,
	type MentionPickerActor,
	buildMentionSections,
	detectMentionTrigger,
	reduceMentionPickerKey,
} from '@/components/chat/mention-picker'
import type { ConversationListItemResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

describe('MENTION_TRIGGER_RE', () => {
	it('matches an `@` at the start of the input', () => {
		expect(MENTION_TRIGGER_RE.test('@')).toBe(true)
	})

	it('matches an `@` immediately after whitespace', () => {
		expect(MENTION_TRIGGER_RE.test('hi @')).toBe(true)
		expect(MENTION_TRIGGER_RE.test('hi @sam')).toBe(true)
	})

	it('does not match `@` in the middle of a word', () => {
		expect(MENTION_TRIGGER_RE.test('user@example.com')).toBe(false)
	})

	it('captures the query text after the `@`', () => {
		const m = /(?:^|\s)@([\w-]*)$/.exec('hey @paul-tren')
		expect(m?.[1]).toBe('paul-tren')
	})
})

describe('detectMentionTrigger', () => {
	it('returns null when the caret is not in a mention context', () => {
		expect(detectMentionTrigger('hello world', 5)).toBeNull()
		expect(detectMentionTrigger('user@host', 9)).toBeNull()
	})

	it('finds the @ and the query text after it', () => {
		const result = detectMentionTrigger('@ab', 3)
		expect(result).toEqual({ atPos: 0, query: 'ab' })
	})

	it('finds an @ that follows whitespace mid-string', () => {
		const text = 'call @sam soon'
		const result = detectMentionTrigger(text.slice(0, 9), 9)
		expect(result).toEqual({ atPos: 5, query: 'sam' })
	})

	it('finds an @ with empty query (immediate open per spec)', () => {
		expect(detectMentionTrigger('hi @', 4)).toEqual({ atPos: 3, query: '' })
	})
})

describe('reduceMentionPickerKey', () => {
	it('advances the highlight on ArrowDown, wrapping at the end', () => {
		const first = reduceMentionPickerKey({ key: 'ArrowDown' }, { flatCount: 3, highlightIndex: 0 })
		expect(first.action).toEqual({ type: 'move', nextIndex: 1 })
		expect(first.preventDefault).toBe(true)

		const wrap = reduceMentionPickerKey({ key: 'ArrowDown' }, { flatCount: 3, highlightIndex: 2 })
		expect(wrap.action).toEqual({ type: 'move', nextIndex: 0 })
	})

	it('wraps to the last row on ArrowUp from index 0', () => {
		const result = reduceMentionPickerKey({ key: 'ArrowUp' }, { flatCount: 4, highlightIndex: 0 })
		expect(result.action).toEqual({ type: 'move', nextIndex: 3 })
	})

	it('commits the highlighted index on Enter', () => {
		const result = reduceMentionPickerKey({ key: 'Enter' }, { flatCount: 3, highlightIndex: 1 })
		expect(result.action).toEqual({ type: 'commit', index: 1 })
	})

	it('closes the picker on Escape', () => {
		const result = reduceMentionPickerKey({ key: 'Escape' }, { flatCount: 3, highlightIndex: 0 })
		expect(result.action).toEqual({ type: 'close' })
	})

	it('leaves unrelated keys unhandled so the composer can insert characters', () => {
		const result = reduceMentionPickerKey({ key: 'a' }, { flatCount: 3, highlightIndex: 0 })
		expect(result.handled).toBe(false)
	})

	it('handles Escape even with an empty flat list (empty query, no matches)', () => {
		const result = reduceMentionPickerKey({ key: 'Escape' }, { flatCount: 0, highlightIndex: 0 })
		expect(result.action).toEqual({ type: 'close' })
	})
})

describe('buildMentionSections', () => {
	const alice: MentionPickerActor = { id: 'alice', name: 'Alice', type: 'human' }
	const bob: MentionPickerActor = { id: 'bob', name: 'Bob', type: 'agent' }
	const carol: MentionPickerActor = { id: 'carol', name: 'Carol', type: 'agent' }
	const dave: MentionPickerActor = { id: 'dave', name: 'Dave', type: 'human' }
	const eve: MentionPickerActor = { id: 'eve', name: 'Eve', type: 'agent' }
	const self: MentionPickerActor = { id: 'me', name: 'Me', type: 'human' }
	const actors: MentionPickerActor[] = [alice, bob, carol, dave, eve, self]

	function makeConversation(
		id: string,
		lastMessageAt: string | null,
		participantIds: string[],
	): ConversationListItemResponse {
		return {
			id,
			workspaceId: 'ws',
			title: id,
			createdBy: 'me',
			lastMessageAt,
			createdAt: null,
			updatedAt: null,
			pinned: false,
			archived: false,
			unread_count: 0,
			snippet: null,
			snippet_actor_id: null,
			snippet_actor_name: null,
			participants: participantIds.map((pid) => ({
				actorId: pid,
				actorName: pid,
				actorType: 'agent' as const,
				joinedAt: null,
				addedBy: null,
			})),
		}
	}

	it('drops self from every section', () => {
		const sections = buildMentionSections({
			actors,
			conversations: [],
			conversationParticipantIds: ['me'],
			query: '',
			selfActorId: 'me',
		})
		const flat = sections.flatMap((s) => s.rows.map((r) => r.id))
		expect(flat).not.toContain('me')
	})

	it('puts current-conversation participants in the "In this conversation" section first', () => {
		const sections = buildMentionSections({
			actors,
			conversations: [],
			conversationParticipantIds: ['alice', 'bob'],
			query: '',
			selfActorId: null,
		})
		expect(sections[0]?.heading).toBe('In this conversation')
		expect(sections[0]?.rows.map((r) => r.id).sort()).toEqual(['alice', 'bob'])
	})

	it('sorts recent collaborators by lastMessageAt desc and dedupes', () => {
		const conversations: ConversationListItemResponse[] = [
			makeConversation('conv-old', '2026-01-01T00:00:00Z', ['carol']),
			makeConversation('conv-new', '2026-06-01T00:00:00Z', ['dave', 'carol']),
			makeConversation('conv-mid', '2026-03-01T00:00:00Z', ['dave']),
		]
		const sections = buildMentionSections({
			actors,
			conversations,
			conversationParticipantIds: [],
			query: '',
			selfActorId: null,
		})
		const recent = sections.find((s) => s.heading === 'Recent collaborators')
		expect(recent?.rows.map((r) => r.id)).toEqual(['dave', 'carol'])
	})

	it('sorts the tail alphabetically under an "Everyone" heading when the query is empty', () => {
		const sections = buildMentionSections({
			actors: [carol, alice, bob],
			conversations: [],
			conversationParticipantIds: [],
			query: '',
			selfActorId: null,
		})
		const remaining = sections.find((s) => s.heading === 'Everyone')
		expect(remaining?.rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
	})

	it('uses the "Matches — \\"{query}\\"" heading when the user has typed a query', () => {
		const sections = buildMentionSections({
			actors,
			conversations: [],
			conversationParticipantIds: [],
			query: 'al',
			selfActorId: null,
		})
		expect(sections[0]?.heading).toBe('Matches — "al"')
		expect(sections[0]?.rows.map((r) => r.id)).toEqual(['alice'])
	})

	it('renders no sections when nothing matches the query', () => {
		const sections = buildMentionSections({
			actors,
			conversations: [],
			conversationParticipantIds: [],
			query: 'zzz',
			selfActorId: null,
		})
		expect(sections).toEqual([])
	})

	it('does not double-count an actor as both current participant and recent collaborator', () => {
		const conversations: ConversationListItemResponse[] = [
			makeConversation('conv-active', '2026-06-01T00:00:00Z', ['alice']),
		]
		const sections = buildMentionSections({
			actors,
			conversations,
			conversationParticipantIds: ['alice'],
			query: '',
			selfActorId: null,
		})
		const inConv = sections.find((s) => s.heading === 'In this conversation')
		const recent = sections.find((s) => s.heading === 'Recent collaborators')
		expect(inConv?.rows.map((r) => r.id)).toContain('alice')
		expect(recent?.rows.map((r) => r.id) ?? []).not.toContain('alice')
	})
})

import { buildVocabulary, pillLabel } from '@/lib/search/vocabulary'
import { describe, expect, it } from 'vitest'
import { vocab } from './fixtures'

describe('buildVocabulary', () => {
	it('knows the four scopes in every workspace', () => {
		const empty = buildVocabulary([])
		for (const w of ['chat', 'chats', 'loop', 'agents', 'automation']) {
			expect(empty.typeWords.has(w)).toBe(true)
		}
	})

	it('maps typed synonyms when the target type exists', () => {
		const expected = {
			company: ['customer', 'client', 'account'],
			contact: ['contact', 'person', 'people'],
			knowledge: ['doc', 'docs', 'document'],
		}
		for (const [key, words] of Object.entries(expected)) {
			for (const w of words) expect(vocab.typeWords.get(w)).toBe(key)
		}
	})

	it('does not activate a synonym whose target type is missing', () => {
		const small = buildVocabulary([{ key: 'bet', label: 'Bet' }])
		for (const w of ['customer', 'person', 'doc', 'people']) {
			expect(small.typeWords.has(w)).toBe(false)
		}
	})

	it('labels the person scope People without claiming typed words from contact', () => {
		const withContact = buildVocabulary([{ key: 'contact', label: 'Contact', plural: 'People' }])
		expect(pillLabel(withContact, 'type', 'person')).toBe('People')
		expect(withContact.typeWords.get('people')).toBe('contact')
		expect(withContact.typeWords.has('person')).toBe(true)
		expect(withContact.typeWords.get('person')).toBe('contact')
		expect(buildVocabulary([]).typeWords.has('person')).toBe(false)
	})

	it('has no owner words', () => {
		for (const w of ['owner', 'mine', 'assignee']) expect(vocab.typeWords.has(w)).toBe(false)
	})

	it('lists loop once even when it is also an object type', () => {
		expect([...vocab.typeLabels.keys()].filter((k) => k === 'loop')).toHaveLength(1)
	})

	it('reads two-word statuses', () => {
		expect(vocab.statusWords.get('in progress')).toBe('in_progress')
		expect(vocab.statusWords.get('needs you')).toBe('needs_you')
		expect(vocab.statusWords.get('at risk')).toBe('needs_you')
	})

	it('labels pills from the real types and the five groups', () => {
		expect(pillLabel(vocab, 'type', 'loop')).toBe('Loops')
		expect(pillLabel(vocab, 'type', 'company')).toBe('Companies')
		expect(pillLabel(vocab, 'type', 'contact')).toBe('People')
		expect(pillLabel(vocab, 'status', 'needs_you')).toBe('Needs you')
		expect(pillLabel(vocab, 'type', 'unknown_type')).toBe('unknown_type')
	})
})

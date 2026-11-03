import {
	TAG_ID_ATTR,
	TAG_LABEL_ATTR,
	editSegments,
	readTagDom,
	splitTextByTags,
	tagLabel,
} from '@/lib/tag-input-model'
import { describe, expect, it } from 'vitest'

const CTO = { id: 'a-cto', name: 'CTO' }
const DEV = { id: 'a-dev', name: 'Developer' }
const labels: Record<string, string> = { 'a-cto': 'CTO', 'a-dev': 'Developer' }
const labelOf = (id: string) => labels[id] ?? null

describe('tagLabel', () => {
	it('is the plain name when nobody else shares it', () => {
		expect(tagLabel(CTO, [CTO, DEV])).toBe('CTO')
	})

	it('adds the email, then a short id, when two actors share a name', () => {
		const a = { id: 'aaaa-1', name: 'Sam', email: 'sam@a.test' }
		const b = { id: 'bbbb-2', name: 'sam' }
		expect(tagLabel(a, [a, b])).toBe('Sam (sam@a.test)')
		expect(tagLabel(b, [a, b])).toBe('sam (bbbb)')
	})
})

describe('splitTextByTags', () => {
	it('turns each tagged name in the text into a chip, in place', () => {
		const { segments, unmatchedIds } = splitTextByTags(
			'ask @CTO and @Developer to start',
			['a-cto', 'a-dev'],
			labelOf,
		)
		expect(segments).toEqual([
			{ kind: 'text', text: 'ask ' },
			{ kind: 'chip', id: 'a-cto', label: 'CTO' },
			{ kind: 'text', text: ' and ' },
			{ kind: 'chip', id: 'a-dev', label: 'Developer' },
			{ kind: 'text', text: ' to start' },
		])
		expect(unmatchedIds).toEqual([])
	})

	it('leaves an id with no place in the text unmatched', () => {
		const { segments, unmatchedIds } = splitTextByTags('hello there', ['a-cto'], labelOf)
		expect(segments).toEqual([{ kind: 'text', text: 'hello there' }])
		expect(unmatchedIds).toEqual(['a-cto'])
	})

	it('does not claim a name that is part of a longer word', () => {
		const { unmatchedIds } = splitTextByTags('mail @CTOs about it', ['a-cto'], labelOf)
		expect(unmatchedIds).toEqual(['a-cto'])
	})

	it('does not claim a typed name for an id that was not tagged', () => {
		const { segments } = splitTextByTags('hi @Developer', ['a-cto'], labelOf)
		expect(segments).toEqual([{ kind: 'text', text: 'hi @Developer' }])
	})

	it('lets a longer name win over a shorter one that starts the same', () => {
		const names: Record<string, string> = { s1: 'Sam', s2: 'Sam Lee' }
		const { segments } = splitTextByTags(
			'ping @Sam Lee now',
			['s1', 's2'],
			(id) => names[id] ?? null,
		)
		expect(segments).toContainEqual({ kind: 'chip', id: 's2', label: 'Sam Lee' })
		expect(segments.some((s) => s.kind === 'chip' && s.id === 's1')).toBe(false)
	})
})

describe('editSegments', () => {
	it('puts tags that were not in the text at the start as chips, one space each', () => {
		expect(editSegments('please start', ['a-cto', 'a-dev'], labelOf)).toEqual([
			{ kind: 'chip', id: 'a-cto', label: 'CTO' },
			{ kind: 'text', text: ' ' },
			{ kind: 'chip', id: 'a-dev', label: 'Developer' },
			{ kind: 'text', text: ' ' },
			{ kind: 'text', text: 'please start' },
		])
	})

	it('leaves tags that are already in the text where they are', () => {
		const out = editSegments('hi @CTO', ['a-cto'], labelOf)
		expect(out[0]).toEqual({ kind: 'text', text: 'hi ' })
		expect(out[1]).toEqual({ kind: 'chip', id: 'a-cto', label: 'CTO' })
	})
})

describe('readTagDom', () => {
	function chip(id: string, label: string) {
		const el = document.createElement('span')
		el.setAttribute(TAG_ID_ATTR, id)
		el.setAttribute(TAG_LABEL_ATTR, label)
		el.textContent = `@${label}`
		return el
	}

	it('reads text, line breaks and chips into text plus the ordered id list', () => {
		const root = document.createElement('div')
		root.append(
			'hi ',
			chip('a-cto', 'CTO'),
			' and ',
			chip('a-dev', 'Developer'),
			document.createElement('br'),
			'go',
		)
		expect(readTagDom(root)).toEqual({
			text: 'hi @CTO and @Developer\ngo',
			ids: ['a-cto', 'a-dev'],
		})
	})

	it('lists an id once however many chips carry it', () => {
		const root = document.createElement('div')
		root.append(chip('a-cto', 'CTO'), ' ', chip('a-cto', 'CTO'))
		expect(readTagDom(root).ids).toEqual(['a-cto'])
	})

	it('adds no id for a name that was typed or pasted as plain text', () => {
		const root = document.createElement('div')
		root.append('hello @CTO')
		expect(readTagDom(root)).toEqual({ text: 'hello @CTO', ids: [] })
	})
})

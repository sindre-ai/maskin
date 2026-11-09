import {
	MAX_MENU_ROWS,
	findMention,
	matchParticipants,
	mentionRows,
	pickParticipant,
} from '@/lib/search/mention'
import { EMPTY_PARTS, addPill, removePill } from '@/lib/search/parts'
import type { ParticipantOption } from '@/lib/search/vocabulary'
import { describe, expect, it } from 'vitest'

const opt = (id: string, name: string, type: 'human' | 'agent' = 'agent'): ParticipantOption => ({
	id,
	name,
	type,
})
const PM = opt('00000000-0000-4000-8000-0000000000a1', 'Product Marketing')
const DEV = opt('00000000-0000-4000-8000-0000000000a2', 'Developer')
const MAYA = opt('00000000-0000-4000-8000-0000000000a3', 'Maya Lindqvist', 'human')
const OPTIONS = [PM, DEV, MAYA]

describe('findMention', () => {
	it('finds an @ that starts a word, with everything typed after it', () => {
		expect(findMention('@prod')).toEqual({ start: 0, query: 'prod' })
		expect(findMention('chats @product marketing')).toEqual({
			start: 6,
			query: 'product marketing',
		})
		expect(findMention('@')).toEqual({ start: 0, query: '' })
	})

	it('ignores an @ inside a word, such as an email address', () => {
		expect(findMention('hans@acme.com')).toBeNull()
		expect(findMention('plain words')).toBeNull()
	})

	it('uses the last @', () => {
		expect(findMention('@dev then @maya')).toEqual({ start: 10, query: 'maya' })
	})
})

describe('matchParticipants', () => {
	it('matches anywhere in the name, names that start with the query first', () => {
		const rows = matchParticipants(OPTIONS, 'ma', [])
		expect(rows.map((r) => r.name)).toEqual(['Maya Lindqvist', 'Product Marketing'])
	})

	it('reads a name with a space and ignores case and a trailing space', () => {
		expect(matchParticipants(OPTIONS, 'PRODUCT mark ', []).map((r) => r.id)).toEqual([PM.id])
	})

	it('shows everyone for a bare @, minus the ones already picked', () => {
		expect(matchParticipants(OPTIONS, '', [DEV.id]).map((r) => r.name)).toEqual([
			'Maya Lindqvist',
			'Product Marketing',
		])
	})

	it('offers nobody once the cap is reached, and never more than the menu holds', () => {
		expect(matchParticipants(OPTIONS, '', ['a', 'b', 'c', 'd', 'e'])).toEqual([])
		const many = Array.from({ length: 20 }, (_, i) => opt(`id-${i}`, `Agent ${i}`))
		expect(matchParticipants(many, '', [])).toHaveLength(MAX_MENU_ROWS)
	})
})

describe('mentionRows', () => {
	it('is empty when nobody matches, so the @word stays plain text', () => {
		expect(mentionRows({ ...EMPTY_PARTS, text: '@zzz' }, OPTIONS)).toEqual([])
		expect(mentionRows({ ...EMPTY_PARTS, text: 'no at sign' }, OPTIONS)).toEqual([])
	})

	it('leaves out an actor that already has a pill', () => {
		const parts = addPill(
			{ ...EMPTY_PARTS, text: '@product' },
			{ kind: 'participant', value: PM.id },
		)
		expect(mentionRows(parts, OPTIONS)).toEqual([])
	})
})

describe('pickParticipant', () => {
	it('takes the @word out of the text and adds a participant pill', () => {
		const parts = pickParticipant({ ...EMPTY_PARTS, text: 'pricing @product mark' }, PM.id)
		expect(parts.text).toBe('pricing ')
		expect(parts.pills).toEqual([{ kind: 'participant', value: PM.id }])
	})

	it('does nothing when there is no @word', () => {
		const parts = { ...EMPTY_PARTS, text: 'pricing' }
		expect(pickParticipant(parts, PM.id)).toBe(parts)
	})

	it('removing the pill only drops the filter: no word comes back, so the menu stays shut', () => {
		const picked = pickParticipant({ ...EMPTY_PARTS, text: '@dev' }, DEV.id)
		const removed = removePill(picked, 0)
		expect(removed.pills).toEqual([])
		expect(removed.text).toBe('')
	})
})

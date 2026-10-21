import {
	extractLinkedFileIds,
	extractLinkedObjectIds,
	showsObjectCard,
	targetOfHref,
} from '@/lib/linked-objects'
import { describe, expect, it } from 'vitest'

const A = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const B = '4aee24db-5d54-476a-8399-9586516e7de1'
const C = '3ecab143-9e98-4474-9e52-779a55d95952'
const D = '024bc0a4-1111-4222-8333-444455556666'

describe('extractLinkedObjectIds', () => {
	it('returns the ids of object links in order of appearance', () => {
		const text = `See [note](https://maskin.io/ws/objects/${A}) and /ws/objects/${B}.`
		expect(extractLinkedObjectIds(text)).toEqual([A, B])
	})

	it('lists an object once however often it is linked', () => {
		expect(extractLinkedObjectIds(`/objects/${A} then /objects/${A.toUpperCase()}`)).toEqual([A])
	})

	it('stops at the maximum', () => {
		const text = [A, B, C, D].map((id) => `/objects/${id}`).join(' ')
		expect(extractLinkedObjectIds(text, 3)).toEqual([A, B, C])
	})

	it('ignores ids that are not object links', () => {
		expect(extractLinkedObjectIds(`session ${A} and /agents/${B}`)).toEqual([])
	})
})

describe('extractLinkedFileIds', () => {
	it('returns the ids of file links in order of appearance', () => {
		const text = `Page https://maskin.io/ws/files/${A} and the image /ws/files/${B}.`
		expect(extractLinkedFileIds(text)).toEqual([A, B])
	})

	it('lists a file once however often it is linked', () => {
		expect(extractLinkedFileIds(`/files/${A} then /files/${A.toUpperCase()}`)).toEqual([A])
	})

	it('stops at the maximum', () => {
		const text = [A, B, C, D].map((id) => `/files/${id}`).join(' ')
		expect(extractLinkedFileIds(text, 3)).toEqual([A, B, C])
	})

	it('does not take an object link for a file link, or the other way round', () => {
		expect(extractLinkedFileIds(`/objects/${A}`)).toEqual([])
		expect(extractLinkedObjectIds(`/files/${A}`)).toEqual([])
	})

	it('returns nothing for text without links', () => {
		expect(extractLinkedFileIds('no links here')).toEqual([])
	})
})

describe('showsObjectCard', () => {
	const draft = { workspaceId: 'ws', content: 'Hej', preview: { body: 'Hej' } }

	it('is true for a draft with text in this workspace', () => {
		expect(showsObjectCard(draft, 'ws')).toBe(true)
	})

	it('is false for a plain task, another workspace, no text, or no object', () => {
		expect(showsObjectCard({ ...draft, preview: null }, 'ws')).toBe(false)
		expect(showsObjectCard(draft, 'other')).toBe(false)
		expect(showsObjectCard({ ...draft, content: '  ' }, 'ws')).toBe(false)
		expect(showsObjectCard(undefined, 'ws')).toBe(false)
	})
})

describe('targetOfHref', () => {
	const id = 'a7167fde-3f84-42ce-800d-2ba2362944ea'

	it('reads an object or file id from an address', () => {
		expect(targetOfHref(`https://x.io/ws/objects/${id.toUpperCase()}`)).toEqual({
			kind: 'object',
			id,
		})
		expect(targetOfHref(`/ws/files/${id}`)).toEqual({ kind: 'file', id })
	})

	it('ignores any other address', () => {
		expect(targetOfHref('https://x.io/ws/agents')).toBeNull()
		expect(targetOfHref(undefined)).toBeNull()
	})
})

describe('extractLinkedObjectIds / extractLinkedFileIds in code and with boundaries', () => {
	it('ignores addresses in inline code and fenced blocks', () => {
		const text = `Use \`/ws/objects/${A}\`.\n\n\`\`\`\n/ws/objects/${B}\n/ws/files/${C}\n\`\`\`\n\nReal: /ws/objects/${D}`
		expect(extractLinkedObjectIds(text)).toEqual([D])
		expect(extractLinkedFileIds(text)).toEqual([])
	})

	it('needs the id to end where an address ends', () => {
		expect(extractLinkedObjectIds(`/ws/objects/${A}x`)).toEqual([])
		expect(extractLinkedObjectIds(`/ws/objects/${A}-more`)).toEqual([])
		expect(
			extractLinkedObjectIds(`(/ws/objects/${A}), /ws/objects/${B}?x=1 /ws/objects/${C}/`),
		).toEqual([A, B, C])
	})
})

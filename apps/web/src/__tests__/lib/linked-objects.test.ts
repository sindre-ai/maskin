import {
	extractLinkedFileIds,
	extractLinkedObjectIds,
	plainSnippet,
	showsObjectCard,
	splitOwnLinks,
	targetOfHref,
} from '@/lib/linked-objects'
import { describe, expect, it } from 'vitest'

const WS = 'e2877e32-2c11-489e-96c8-a76200908ed4'
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

	it('reads a loop or trigger id from an address', () => {
		expect(targetOfHref(`https://x.io/ws/loops/${id.toUpperCase()}`)).toEqual({ kind: 'loop', id })
		expect(targetOfHref(`/ws/triggers/${id}?tab=x`)).toEqual({ kind: 'trigger', id })
	})

	it('ignores a loop or trigger address with more id characters after the id', () => {
		expect(targetOfHref(`/ws/loops/${id}x`)).toBeNull()
		expect(targetOfHref('/ws/loops')).toBeNull()
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

describe('splitOwnLinks', () => {
	const url = (kind: string, id: string) => `https://maskin.io/${WS}/${kind}/${id}`

	it('keeps the words and the link in the order they were written', () => {
		expect(splitOwnLinks(`is this done? ${url('objects', A)} thanks`, WS)).toEqual([
			{ kind: 'text', text: 'is this done? ' },
			{ kind: 'object', id: A },
			{ kind: 'text', text: ' thanks' },
		])
	})

	it('finds a link to a file and leaves the sentence punctuation in the words', () => {
		expect(splitOwnLinks(`see ${url('files', B)}.`, WS)).toEqual([
			{ kind: 'text', text: 'see ' },
			{ kind: 'file', id: B },
			{ kind: 'text', text: '.' },
		])
	})

	it('is just the link when the message is only the link', () => {
		expect(splitOwnLinks(url('objects', A), WS)).toEqual([{ kind: 'object', id: A }])
	})

	it('keeps every link, including a repeated one', () => {
		const link = url('objects', A)
		expect(splitOwnLinks(`${link} ${link}`, WS).filter((s) => s.kind === 'object')).toHaveLength(2)
	})

	it('finds a bare address of a loop and of a trigger', () => {
		expect(splitOwnLinks(`${url('loops', A)} wakes ${url('triggers', B)}`, WS)).toEqual([
			{ kind: 'loop', id: A },
			{ kind: 'text', text: ' wakes ' },
			{ kind: 'trigger', id: B },
		])
	})

	it('leaves a loop address of another workspace as words', () => {
		const other = `https://maskin.io/${A}/loops/${B}`
		expect(splitOwnLinks(other, WS)).toEqual([{ kind: 'text', text: other }])
	})

	it('leaves links to another workspace, another site or a non-object page as words', () => {
		const other = `https://maskin.io/${A}/objects/${B}`
		const elsewhere = `https://example.com/${WS}/objects/${A}`
		const page = url('agents', A)
		for (const text of [other, elsewhere, page, 'no links here']) {
			expect(splitOwnLinks(text, WS)).toEqual([{ kind: 'text', text }])
		}
	})
})

describe('plainSnippet', () => {
	it('turns markdown into plain words on one line', () => {
		expect(
			plainSnippet(
				'## Plan\n\n- Do **the thing**\n- See [the doc](https://x.test)\n\n```\ncode\n```',
			),
		).toBe('Plan Do the thing See the doc')
	})

	it('is empty for no text', () => {
		expect(plainSnippet(null)).toBe('')
		expect(plainSnippet('  \n ')).toBe('')
	})

	it('cuts a long text', () => {
		const out = plainSnippet('word '.repeat(200))
		expect(out.length).toBeLessThanOrEqual(281)
		expect(out.endsWith('…')).toBe(true)
	})
})

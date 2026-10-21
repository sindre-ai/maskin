import {
	extractLinkedFileIds,
	extractLinkedObjectIds,
	splitAtLinkedObjects,
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

describe('splitAtLinkedObjects', () => {
	it('keeps a message without links as one piece', () => {
		expect(splitAtLinkedObjects('One.\n\nTwo.')).toEqual([{ text: 'One.\n\nTwo.', objectIds: [] }])
	})

	it('puts the card right after the paragraph that links it', () => {
		const text = `Intro.\n\nDraft: /objects/${A}\n\nClosing.`
		expect(splitAtLinkedObjects(text)).toEqual([
			{ text: `Intro.\n\nDraft: /objects/${A}`, objectIds: [A] },
			{ text: 'Closing.', objectIds: [] },
		])
	})

	it('gives a repeated link one card, at its first mention', () => {
		const text = `First /objects/${A}\n\nAgain /objects/${A}`
		expect(splitAtLinkedObjects(text).map((s) => s.objectIds)).toEqual([[A], []])
	})

	it('does not cut inside a fenced block', () => {
		const text = `Look:\n\n\`\`\`\nline\n\n/objects/${A}\n\`\`\`\n\nDone.`
		const segments = splitAtLinkedObjects(text)
		expect(segments[0].text).toContain('line\n\n/objects/')
		expect(segments[0].objectIds).toEqual([A])
	})

	it('stops giving cards after the maximum', () => {
		const text = [A, B, C, D].map((id) => `/objects/${id}`).join('\n\n')
		expect(splitAtLinkedObjects(text, 3).flatMap((s) => s.objectIds)).toEqual([A, B, C])
	})
})

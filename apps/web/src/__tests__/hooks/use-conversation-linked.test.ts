import { deriveLinkedItems } from '@/hooks/use-conversation-linked'
import type { MessageResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

const OBJ_A = '11111111-1111-1111-1111-111111111111'
const OBJ_B = '22222222-2222-2222-2222-222222222222'
const FILE_A = '33333333-3333-3333-3333-333333333333'

function message(
	id: number,
	content: string,
	extra: Partial<MessageResponse> = {},
): MessageResponse {
	return {
		id,
		conversationId: 'c1',
		actorId: `actor-${id}`,
		actorName: `Actor ${id}`,
		actorType: 'agent',
		kind: 'message',
		content,
		metadata: null,
		sessionId: null,
		createdAt: '2026-10-21T10:00:00Z',
		editedAt: null,
		...extra,
	} as MessageResponse
}

describe('deriveLinkedItems', () => {
	it('does not list a link that only appears in a code span', () => {
		expect(deriveLinkedItems([message(1, `see \`/objects/${OBJ_A}\` in the docs`)])).toEqual([])
	})

	it('lists objects and files newest message first', () => {
		const items = deriveLinkedItems([
			message(1, `[a](/ws/objects/${OBJ_A})`),
			message(2, `[b](/ws/objects/${OBJ_B}) and [f](/ws/files/${FILE_A})`),
		])
		expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
			`object:${OBJ_B}`,
			`file:${FILE_A}`,
			`object:${OBJ_A}`,
		])
	})

	it('keeps the newest linking message when an item is linked twice', () => {
		const items = deriveLinkedItems([
			message(1, `/objects/${OBJ_A}`),
			message(5, `/objects/${OBJ_A}`),
		])
		expect(items).toHaveLength(1)
		expect(items[0].messageId).toBe(5)
		expect(items[0].actorName).toBe('Actor 5')
	})

	it('ignores messages without links and system messages', () => {
		const items = deriveLinkedItems([
			message(1, 'plain text'),
			message(2, `/objects/${OBJ_A}`, { kind: 'system' }),
		])
		expect(items).toEqual([])
	})

	it('caps the list', () => {
		const items = deriveLinkedItems(
			[message(1, `/objects/${OBJ_A} /objects/${OBJ_B} /files/${FILE_A}`)],
			2,
		)
		expect(items).toHaveLength(2)
	})
})

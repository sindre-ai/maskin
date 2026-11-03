import { safeReturnPath } from '@/lib/return-path'
import { describe, expect, it } from 'vitest'

const WS = '11111111-1111-1111-1111-111111111111'

describe('safeReturnPath', () => {
	it('accepts a chat path inside the current workspace', () => {
		const path = `/${WS}/chats/22222222-2222-2222-2222-222222222222`
		expect(safeReturnPath(path, WS)).toBe(path)
	})

	it.each([
		['an absolute URL', 'https://evil.example/phish'],
		['a protocol-relative URL', '//evil.example/phish'],
		['a path into another workspace', '/99999999-9999-9999-9999-999999999999/chats/x'],
		['traversal', `/${WS}/../other`],
		['a javascript: URL', 'javascript:alert(1)'],
		['a query string', `/${WS}/chats/x?next=https://evil.example`],
		['a non-string', undefined],
	])('rejects %s', (_label, value) => {
		expect(safeReturnPath(value, WS)).toBeUndefined()
	})
})

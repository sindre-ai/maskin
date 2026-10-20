import { describe, expect, it } from 'vitest'
import {
	frontendUrlForReturn,
	sanitizeReturnPath,
} from '../../../lib/integrations/oauth/return-path'

const WS = '11111111-1111-1111-1111-111111111111'

describe('sanitizeReturnPath', () => {
	it('accepts a chat path inside the workspace', () => {
		const path = `/${WS}/chats/22222222-2222-2222-2222-222222222222`
		expect(sanitizeReturnPath(path, WS)).toBe(path)
	})

	it.each([
		['an absolute URL', 'https://evil.example/phish'],
		['a protocol-relative URL', '//evil.example/phish'],
		['a path into another workspace', '/99999999-9999-9999-9999-999999999999/chats/x'],
		['a path outside any workspace', '/settings'],
		['traversal out of the workspace', `/${WS}/../other/chats/x`],
		['a backslash', `/${WS}/chats\\x`],
		['a query string', `/${WS}/chats/x?next=https://evil.example`],
		['a javascript: URL', 'javascript:alert(1)'],
		['an empty string', ''],
		['a non-string', 42],
		['an over-long path', `/${WS}/${'a'.repeat(400)}`],
	])('rejects %s', (_label, value) => {
		expect(sanitizeReturnPath(value, WS)).toBeUndefined()
	})
})

describe('frontendUrlForReturn', () => {
	it('lands on the settings page when there is no return path', () => {
		expect(frontendUrlForReturn(WS)).toMatch(new RegExp(`/${WS}/settings/integrations$`))
	})

	it('lands on the return path when there is one', () => {
		const path = `/${WS}/chats/abc`
		expect(frontendUrlForReturn(WS, path)).toMatch(new RegExp(`${path}$`))
	})
})

import { describe, expect, it } from 'vitest'
import { safeInternalPath } from '../../lib/safe-redirect'

describe('safeInternalPath', () => {
	it('keeps a path inside the app, query string and all', () => {
		expect(safeInternalPath('/connect/skjald?state=abc&code_challenge=x')).toBe(
			'/connect/skjald?state=abc&code_challenge=x',
		)
		expect(safeInternalPath('/')).toBe('/')
	})

	it('refuses anything that could leave the app', () => {
		for (const raw of [
			'//evil.example',
			'/\\evil.example',
			'https://evil.example',
			'javascript:alert(1)',
			'connect/skjald',
			'/a\nb',
			'',
			undefined,
			42,
			`/${'a'.repeat(2001)}`,
		]) {
			expect(safeInternalPath(raw)).toBeNull()
		}
	})
})

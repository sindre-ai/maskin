import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatCredentialLogDetail } from '../../lib/integrations/credential-log-detail'

const APPROVER = '11111111-1111-4111-8111-111111111111'
const GRANT = '22222222-2222-4222-8222-222222222222'
const EXT = '33333333-3333-4333-8333-333333333333'

describe('formatCredentialLogDetail', () => {
	it('writes all four keys in the fixed order', () => {
		expect(formatCredentialLogDetail({ approver: APPROVER, grant: GRANT, tier: 1, ext: EXT })).toBe(
			`approver=${APPROVER};grant=${GRANT};tier=1;ext=${EXT}`,
		)
	})

	it('leaves an absent key empty and keeps every key present', () => {
		expect(formatCredentialLogDetail({})).toBe('approver=;grant=;tier=;ext=')
		expect(formatCredentialLogDetail({ tier: 2 })).toBe('approver=;grant=;tier=2;ext=')
		expect(formatCredentialLogDetail({ grant: GRANT, approver: null, ext: undefined })).toBe(
			`approver=;grant=${GRANT};tier=;ext=`,
		)
	})

	it('writes a tier change as tier only, with the other three keys present and empty', () => {
		for (const tier of [1, 2, 3] as const) {
			expect(formatCredentialLogDetail({ tier })).toBe(`approver=;grant=;tier=${tier};ext=`)
		}
	})

	it('keeps the key order whatever order the input names them in', () => {
		expect(formatCredentialLogDetail({ ext: EXT, tier: 3, grant: GRANT, approver: APPROVER })).toBe(
			`approver=${APPROVER};grant=${GRANT};tier=3;ext=${EXT}`,
		)
	})

	it('lowercases a uuid so one id has one spelling in the hashed text', () => {
		expect(formatCredentialLogDetail({ approver: APPROVER.toUpperCase() })).toBe(
			`approver=${APPROVER};grant=;tier=;ext=`,
		)
	})

	it('refuses anything that is not a uuid or a tier, so request text cannot get in', () => {
		expect(() => formatCredentialLogDetail({ approver: 'x;tier=1' })).toThrow(/approver/)
		expect(() => formatCredentialLogDetail({ grant: 'please approve this' })).toThrow(/grant/)
		expect(() => formatCredentialLogDetail({ ext: `${EXT};tier=1` })).toThrow(/ext/)
		expect(() => formatCredentialLogDetail({ tier: 4 as never })).toThrow(/tier/)
		expect(() => formatCredentialLogDetail({ tier: '1' as never })).toThrow(/tier/)
	})

	it('stays far under the 512 character column limit and never holds the unit separator', () => {
		const text = formatCredentialLogDetail({ approver: APPROVER, grant: GRANT, tier: 1, ext: EXT })
		expect(text.length).toBeLessThan(512)
		expect(text).not.toContain('\u001f')
	})
})

describe('who may call the canonical writer', () => {
	// The writer owns the text hashed into the audit chain. It is called from the
	// getCredential and grant path and from the tier-marking route, which writes the
	// tier only. A new caller is a decision, so it has to show up here on purpose.
	const ALLOWED = new Set([
		'lib/integrations/credential-log-detail.ts',
		'routes/integrations-keychain.ts',
	])

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const full = join(dir, name)
			if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full)
			return full.endsWith('.ts') ? [full] : []
		})
	}

	it('is imported only by the allowed files', () => {
		const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
		const importers = sourceFiles(srcRoot)
			.filter((f) => /credential-log-detail/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(srcRoot, f).split('\\').join('/'))
		expect(importers.filter((f) => !ALLOWED.has(f))).toEqual([])
	})

	it('is never given the reason text or the session id of an access request', () => {
		const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
		const requestCode = ['lib/integrations/access-requests.ts', 'routes/access-requests.ts']
		for (const f of requestCode) {
			expect(readFileSync(join(srcRoot, f), 'utf8')).not.toMatch(/formatCredentialLogDetail/)
		}
	})
})

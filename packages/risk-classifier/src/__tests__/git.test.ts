import { describe, expect, it } from 'vitest'
import { assertGitRef, assertGitSha } from '../lib/git.js'

describe('assertGitRef', () => {
	it('accepts ordinary refs', () => {
		expect(() => assertGitRef('HEAD')).not.toThrow()
		expect(() => assertGitRef('origin/main')).not.toThrow()
		expect(() => assertGitRef('refs/tags/v1.2.3')).not.toThrow()
		expect(() => assertGitRef('cafebabecafebabecafebabecafebabecafebabe')).not.toThrow()
		expect(() => assertGitRef('feature/auth-rewrite')).not.toThrow()
	})

	it('rejects refs that start with a dash (would look like a flag to git)', () => {
		expect(() => assertGitRef('--upload-pack=evil')).toThrow(/Invalid git revision/)
	})

	it('rejects refs containing `..` (path traversal / range syntax)', () => {
		expect(() => assertGitRef('main..evil')).toThrow(/Invalid git revision/)
	})

	it('rejects refs with shell metacharacters', () => {
		expect(() => assertGitRef('main;rm -rf /')).toThrow(/Invalid git revision/)
		expect(() => assertGitRef('main$(whoami)')).toThrow(/Invalid git revision/)
		expect(() => assertGitRef(' main')).toThrow(/Invalid git revision/)
	})
})

describe('assertGitSha', () => {
	it('accepts a 40-char hex SHA', () => {
		expect(() => assertGitSha('cafebabecafebabecafebabecafebabecafebabe')).not.toThrow()
	})

	it('rejects refs that are not pure hex', () => {
		expect(() => assertGitSha('origin/main')).toThrow()
		expect(() => assertGitSha('HEAD')).toThrow()
	})
})

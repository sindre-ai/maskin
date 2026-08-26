import { describe, expect, it } from 'vitest'
import {
	AGENT_GIT_IDENTITY_EMAIL,
	AGENT_GIT_IDENTITY_FALLBACK_NAME,
	buildAgentGitIdentity,
	sanitizeGitIdentName,
} from '../../lib/git-identity'

describe('sanitizeGitIdentName', () => {
	it('returns a clean name unchanged', () => {
		expect(sanitizeGitIdentName('Code Reviewer')).toBe('Code Reviewer')
	})

	it('returns empty string for null, undefined, and blank input', () => {
		expect(sanitizeGitIdentName(null)).toBe('')
		expect(sanitizeGitIdentName(undefined)).toBe('')
		expect(sanitizeGitIdentName('   ')).toBe('')
	})

	it('strips angle brackets that would terminate the ident grammar', () => {
		expect(sanitizeGitIdentName('Evil <attacker@example.com>')).toBe('Evil attacker@example.com')
	})

	it('strips newlines and control characters', () => {
		const raw = ['Code', 'Reviewer'].join(String.fromCharCode(10))
		expect(sanitizeGitIdentName(raw)).toBe('Code Reviewer')
		expect(sanitizeGitIdentName(`A${String.fromCharCode(0)}B`)).toBe('A B')
		expect(sanitizeGitIdentName(`A${String.fromCharCode(127)}B`)).toBe('A B')
	})

	it('collapses runs of whitespace and trims', () => {
		expect(sanitizeGitIdentName('  Senior   Developer  ')).toBe('Senior Developer')
	})

	it('truncates to 64 characters without leaving trailing whitespace', () => {
		const result = sanitizeGitIdentName(`${'a'.repeat(63)}   tail`)
		expect(result).toBe('a'.repeat(63))
		expect(result.length).toBeLessThanOrEqual(64)
	})

	it('leaves nothing usable when the name is only ident-breaking characters', () => {
		expect(sanitizeGitIdentName('<>')).toBe('')
	})
})

describe('buildAgentGitIdentity', () => {
	it('suffixes the sanitized agent name', () => {
		expect(buildAgentGitIdentity('Code Reviewer').name).toBe('Code Reviewer (Maskin agent)')
	})

	it('falls back to the generic name when nothing usable remains', () => {
		expect(buildAgentGitIdentity('<>').name).toBe(
			`${AGENT_GIT_IDENTITY_FALLBACK_NAME} (Maskin agent)`,
		)
		expect(buildAgentGitIdentity(null).name).toBe(
			`${AGENT_GIT_IDENTITY_FALLBACK_NAME} (Maskin agent)`,
		)
	})

	it('does not double-append the suffix', () => {
		expect(buildAgentGitIdentity('Code Reviewer (Maskin agent)').name).toBe(
			'Code Reviewer (Maskin agent)',
		)
	})

	it('always uses the unclaimable GitHub noreply address', () => {
		expect(buildAgentGitIdentity('Code Reviewer').email).toBe(AGENT_GIT_IDENTITY_EMAIL)
		expect(AGENT_GIT_IDENTITY_EMAIL).toMatch(/@users[.]noreply[.]github[.]com$/)
	})

	it('never produces an ident git would reject', () => {
		const hostile = `Bad${String.fromCharCode(10)}<name>${String.fromCharCode(0)}`
		const { name, email } = buildAgentGitIdentity(hostile)
		for (const value of [name, email]) {
			expect(value).not.toMatch(/[<>]/)
			expect(value).not.toMatch(/\p{Cc}/u)
		}
	})
})

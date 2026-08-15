import { describe, expect, it } from 'vitest'
import {
	DEFAULT_APPROVER_ORDER,
	type GitHubIdentity,
	assertApproverNotAuthor,
	resolveApprover,
} from '../../../lib/github/approver'

const identity = (name: string, login: string, id?: number): GitHubIdentity => ({
	name,
	login,
	id,
})

const fourIdentities = (): Record<string, GitHubIdentity> => ({
	github: identity('github', 'sindre-maskin', 1001),
	github_approver: identity('github_approver', 'maskin-approver', 1002),
	'github-sindre-ai': identity('github-sindre-ai', 'sindre-ai', 1003),
	'github-vaerksted-ai': identity('github-vaerksted-ai', 'vaerksted-ai', 1004),
})

describe('DEFAULT_APPROVER_ORDER', () => {
	it('leads with github_approver, then vaerksted, then sindre — additional identities append', () => {
		expect(DEFAULT_APPROVER_ORDER).toEqual([
			'github_approver',
			'github-vaerksted-ai',
			'github-sindre-ai',
		])
	})

	it('is frozen so additions cannot silently prepend', () => {
		expect(Object.isFrozen(DEFAULT_APPROVER_ORDER)).toBe(true)
	})
})

describe('resolveApprover', () => {
	it('picks the first identity in the default order when none matches the author', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'external-contributor', id: 9999 },
			identities: fourIdentities(),
		})
		expect(chosen?.name).toBe('github_approver')
	})

	it('skips the first identity when its login matches the PR author (PAT era)', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'maskin-approver' },
			identities: fourIdentities(),
		})
		expect(chosen?.name).toBe('github-vaerksted-ai')
	})

	it('prefers GitHub user id over login when both sides expose it', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'unrelated-login', id: 1002 },
			identities: fourIdentities(),
		})
		expect(chosen?.name).toBe('github-vaerksted-ai')
	})

	it('compares login case-insensitively — GitHub logins are case-preserving but not case-sensitive', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'MASKIN-APPROVER' },
			identities: fourIdentities(),
		})
		expect(chosen?.name).toBe('github-vaerksted-ai')
	})

	it('honours a caller-supplied order verbatim', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'external-contributor' },
			identities: fourIdentities(),
			order: ['github-sindre-ai', 'github_approver', 'github-vaerksted-ai'],
		})
		expect(chosen?.name).toBe('github-sindre-ai')
	})

	it('appends extra identities without displacing the default primary', () => {
		const extra = {
			...fourIdentities(),
			'github-new-org': identity('github-new-org', 'new-org-bot', 1005),
		}
		const chosen = resolveApprover({
			prAuthor: { login: 'external-contributor' },
			identities: extra,
			order: [...DEFAULT_APPROVER_ORDER, 'github-new-org'],
		})
		expect(chosen?.name).toBe('github_approver')
	})

	it('skips identities missing from the pool without error', () => {
		const partial: Record<string, GitHubIdentity> = {
			'github-vaerksted-ai': identity('github-vaerksted-ai', 'vaerksted-ai', 1004),
		}
		const chosen = resolveApprover({
			prAuthor: { login: 'external-contributor' },
			identities: partial,
		})
		expect(chosen?.name).toBe('github-vaerksted-ai')
	})

	it('returns null when every candidate identity is the PR author', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'maskin-approver', id: 1002 },
			identities: {
				github_approver: identity('github_approver', 'maskin-approver', 1002),
			},
		})
		expect(chosen).toBeNull()
	})

	it('returns null when the pool is empty', () => {
		const chosen = resolveApprover({
			prAuthor: { login: 'anyone' },
			identities: {},
		})
		expect(chosen).toBeNull()
	})
})

describe('assertApproverNotAuthor', () => {
	it('is a no-op when the approver is a different actor', () => {
		expect(() =>
			assertApproverNotAuthor(identity('github_approver', 'maskin-approver', 1002), {
				login: 'external-contributor',
				id: 9999,
			}),
		).not.toThrow()
	})

	it('throws when the resolved approver equals the PR author by id', () => {
		expect(() =>
			assertApproverNotAuthor(identity('github_approver', 'unrelated', 1002), {
				login: 'unrelated-2',
				id: 1002,
			}),
		).toThrow(/Refusing to approve/)
	})

	it('throws when the resolved approver equals the PR author by login (PAT era, no id)', () => {
		expect(() =>
			assertApproverNotAuthor(identity('github_approver', 'maskin-approver'), {
				login: 'maskin-approver',
			}),
		).toThrow(/maskin-approver/)
	})
})

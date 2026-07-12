import { describe, expect, it } from 'vitest'
import {
	TOOL_PERMISSIONS,
	UnmappedToolError,
	deriveScope,
	normalizeRepo,
} from '../../../../lib/integrations/providers/github/scope'

describe('normalizeRepo', () => {
	it('strips owner from owner/repo form', () => {
		expect(normalizeRepo('sindre-ai/maskin')).toBe('maskin')
	})

	it('returns bare repo unchanged when no slash present', () => {
		expect(normalizeRepo('maskin')).toBe('maskin')
	})

	it('accepts dots, dashes, and underscores', () => {
		expect(normalizeRepo('sindre-ai/my.repo_v2-final')).toBe('my.repo_v2-final')
	})

	it('rejects command injection attempts', () => {
		expect(() => normalizeRepo('maskin; rm -rf /')).toThrow()
		expect(() => normalizeRepo('a/b/c')).toThrow()
		expect(() => normalizeRepo('$(whoami)')).toThrow()
	})
})

describe('deriveScope', () => {
	it('scopes to a single repo when repo is supplied', () => {
		const scope = deriveScope({ toolName: 'create_pull_request', repo: 'sindre-ai/maskin' })
		expect(scope.repositories).toEqual(['maskin'])
		expect(scope.permissions).toEqual({ pull_requests: 'write', metadata: 'read' })
	})

	it('omits `repositories` when repo is not supplied so cross-repo calls still work', () => {
		const scope = deriveScope({ toolName: 'search_repositories' })
		expect(scope.repositories).toBeUndefined()
		expect(scope.permissions).toEqual({ metadata: 'read' })
	})

	it('gives merge_pull_request both write scopes it needs', () => {
		// GitHub's merge PR endpoint updates the base branch head, so contents:write
		// is required alongside pull_requests:write. Missing either fails the merge.
		const scope = deriveScope({ toolName: 'merge_pull_request', repo: 'maskin' })
		expect(scope.permissions).toMatchObject({
			pull_requests: 'write',
			contents: 'write',
		})
	})

	it('gives get_pull_request_status the checks:read scope so PR status calls succeed', () => {
		const scope = deriveScope({ toolName: 'get_pull_request_status', repo: 'maskin' })
		expect(scope.permissions).toMatchObject({
			pull_requests: 'read',
			checks: 'read',
		})
	})

	it('grants `git` credential-helper invocations contents:write, not full install scope', () => {
		const scope = deriveScope({ toolName: 'git', repo: 'sindre-ai/maskin' })
		expect(scope.repositories).toEqual(['maskin'])
		expect(scope.permissions).toEqual({ contents: 'write', metadata: 'read' })
	})

	it('throws UnmappedToolError for unknown tools — no silent fallback to full install scope', () => {
		expect(() => deriveScope({ toolName: 'delete_the_org', repo: 'maskin' })).toThrow(
			UnmappedToolError,
		)
	})

	it('names the offending tool in the error message so the mapping can be extended', () => {
		try {
			deriveScope({ toolName: 'transfer_repository', repo: 'maskin' })
			throw new Error('deriveScope should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(UnmappedToolError)
			expect((err as UnmappedToolError).toolName).toBe('transfer_repository')
			expect((err as Error).message).toContain('transfer_repository')
			expect((err as Error).message).toContain('TOOL_PERMISSIONS')
		}
	})

	it('keeps every mapped permission inside T1 manifest ceiling (contents / pull_requests / checks / metadata)', () => {
		const allowed = new Set(['contents', 'pull_requests', 'checks', 'metadata'])
		for (const [tool, perms] of Object.entries(TOOL_PERMISSIONS)) {
			for (const key of Object.keys(perms)) {
				expect(
					allowed.has(key),
					`Tool "${tool}" requests permission "${key}" outside the T1 App manifest ceiling. Either extend .github/agent-app/manifest.json first or drop the tool from the mapping.`,
				).toBe(true)
			}
		}
	})

	it('deep-copies the permission set so callers can mutate their scope without corrupting the shared map', () => {
		const a = deriveScope({ toolName: 'create_pull_request', repo: 'maskin' })
		if (a.permissions) a.permissions.contents = 'write'
		const b = deriveScope({ toolName: 'create_pull_request', repo: 'maskin' })
		expect(b.permissions?.contents).toBeUndefined()
	})
})

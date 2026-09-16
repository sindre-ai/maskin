import { describe, expect, it } from 'vitest'
import { globMatch } from '../lib/match.js'

describe('globMatch', () => {
	it('matches double-star paths', () => {
		expect(globMatch('packages/auth/**', 'packages/auth/src/index.ts')).toBe(true)
		expect(globMatch('packages/auth/**', 'packages/db/src/index.ts')).toBe(false)
	})

	it('matches single-star segments', () => {
		expect(globMatch('apps/dev/src/routes/auth*', 'apps/dev/src/routes/auth.ts')).toBe(true)
		expect(globMatch('apps/dev/src/routes/auth*', 'apps/dev/src/routes/items.ts')).toBe(false)
	})

	it('binds a root-level file via the depth-agnostic form (dot-star matches empty)', () => {
		// The agent-governing floors ship as `**/AGENTS.md` etc. so they bind at
		// any depth. That relies on the `**/` prefix compiling to `.*` with the
		// trailing slash consumed, so `.*` must be allowed to match the empty
		// string — otherwise the entry binds nested files only and silently
		// un-floors the repo-root AGENTS.md. See .maskin/protected-paths.yml.
		expect(globMatch('**/AGENTS.md', 'AGENTS.md')).toBe(true)
	})

	it('matches `**/*secret*` style patterns', () => {
		expect(globMatch('**/*secret*', 'apps/web/src/lib/secrets.ts')).toBe(true)
		expect(globMatch('**/*secret*', 'README.md')).toBe(false)
	})

	it('matches exact file paths', () => {
		expect(globMatch('prisma/schema.prisma', 'prisma/schema.prisma')).toBe(true)
		expect(globMatch('prisma/schema.prisma', 'prisma/migrations/0001.sql')).toBe(false)
	})
})

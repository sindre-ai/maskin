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

	it('matches `**/*secret*` style patterns', () => {
		expect(globMatch('**/*secret*', 'apps/web/src/lib/secrets.ts')).toBe(true)
		expect(globMatch('**/*secret*', 'README.md')).toBe(false)
	})

	it('matches exact file paths', () => {
		expect(globMatch('prisma/schema.prisma', 'prisma/schema.prisma')).toBe(true)
		expect(globMatch('prisma/schema.prisma', 'prisma/migrations/0001.sql')).toBe(false)
	})
})

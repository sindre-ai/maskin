import { describe, expect, it } from 'vitest'
import { isGeneratedFile } from '../lib/generated.js'

describe('isGeneratedFile', () => {
	it.each([
		'apps/apple/openapi.json',
		'apps/apple/Sources/MaskinAPI/openapi.json',
		'apps/apple/Sources/MaskinAPI/Generated/Client.swift',
		'packages/db/drizzle/meta/0108_snapshot.json',
		'packages/db/drizzle/meta/_journal.json',
		'pnpm-lock.yaml',
		'apps/web/package-lock.json',
	])('treats %s as generated', (path) => {
		expect(isGeneratedFile(path)).toBe(true)
	})

	it.each([
		'apps/dev/src/openapi.ts',
		'packages/db/drizzle/0108_x.sql',
		'packages/db/src/schema.ts',
		'.maskin/core-tables.yml',
		'.github/workflows/ci.yml',
	])('does not treat %s as generated', (path) => {
		expect(isGeneratedFile(path)).toBe(false)
	})
})

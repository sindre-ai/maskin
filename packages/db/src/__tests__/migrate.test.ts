import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(),
	readdirSync: vi.fn(),
}))

import { readdirSync } from 'node:fs'
import { listMigrationFiles } from '../migrate-utils'

describe('listMigrationFiles', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('returns only .sql files, sorted', () => {
		vi.mocked(readdirSync).mockReturnValue([
			'0002_add_index.sql',
			'0001_init.sql',
		] as unknown as ReturnType<typeof readdirSync>)

		expect(listMigrationFiles('/fake/dir')).toEqual([
			'0001_init.sql',
			'0002_add_index.sql',
		])
	})

	it('excludes .down.sql files', () => {
		vi.mocked(readdirSync).mockReturnValue([
			'0001_init.sql',
			'0001_init.down.sql',
			'0002_add_table.sql',
			'0002_add_table.down.sql',
		] as unknown as ReturnType<typeof readdirSync>)

		expect(listMigrationFiles('/fake/dir')).toEqual([
			'0001_init.sql',
			'0002_add_table.sql',
		])
	})

	it('excludes non-sql files', () => {
		vi.mocked(readdirSync).mockReturnValue([
			'0001_init.sql',
			'snapshot.json',
			'meta.toml',
		] as unknown as ReturnType<typeof readdirSync>)

		expect(listMigrationFiles('/fake/dir')).toEqual(['0001_init.sql'])
	})

	it('passes the directory to readdirSync', () => {
		vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>)

		listMigrationFiles('/specific/path')

		expect(readdirSync).toHaveBeenCalledWith('/specific/path')
	})
})

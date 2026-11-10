import { describe, expect, it } from 'vitest'
import {
	APP_DB_POOL_SIZE_DEFAULT,
	APP_DB_POOL_SIZE_MAX,
	resolveDbPoolConfig,
} from '../../lib/db-pool-config'

describe('resolveDbPoolConfig', () => {
	it('uses the defaults when nothing is set', () => {
		expect(resolveDbPoolConfig({})).toEqual({
			poolSize: APP_DB_POOL_SIZE_DEFAULT,
			shedAt: APP_DB_POOL_SIZE_DEFAULT,
		})
	})

	it('reads DB_POOL_SIZE, and sheds at a pool size of stalled queries by default', () => {
		expect(resolveDbPoolConfig({ DB_POOL_SIZE: '30' })).toEqual({ poolSize: 30, shedAt: 30 })
	})

	it.each(['abc', '', '0', '-4', '2.5', String(APP_DB_POOL_SIZE_MAX + 1)])(
		'falls back to the default for DB_POOL_SIZE=%j',
		(value) => {
			expect(resolveDbPoolConfig({ DB_POOL_SIZE: value }).poolSize).toBe(APP_DB_POOL_SIZE_DEFAULT)
		},
	)

	it('takes DB_SHED_AT as an absolute count, and ignores a value that is not a whole number', () => {
		expect(resolveDbPoolConfig({ DB_SHED_AT: '500' }).shedAt).toBe(500)
		expect(resolveDbPoolConfig({ DB_SHED_AT: 'x' }).shedAt).toBe(APP_DB_POOL_SIZE_DEFAULT)
		expect(resolveDbPoolConfig({ DB_SHED_AT: '0' }).shedAt).toBe(APP_DB_POOL_SIZE_DEFAULT)
	})
})

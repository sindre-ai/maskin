import { describe, expect, it } from 'vitest'
import {
	APP_DB_POOL_SIZE_DEFAULT,
	APP_DB_POOL_SIZE_MAX,
	SHED_QUERIES_PER_CONNECTION,
	resolveDbPoolConfig,
} from '../../lib/db-pool-config'

describe('resolveDbPoolConfig', () => {
	it('uses the defaults when nothing is set', () => {
		expect(resolveDbPoolConfig({})).toEqual({
			poolSize: APP_DB_POOL_SIZE_DEFAULT,
			shedAt: APP_DB_POOL_SIZE_DEFAULT * SHED_QUERIES_PER_CONNECTION,
		})
	})

	it('reads DB_POOL_SIZE and scales the shed limit with it', () => {
		expect(resolveDbPoolConfig({ DB_POOL_SIZE: '30' })).toEqual({
			poolSize: 30,
			shedAt: 30 * SHED_QUERIES_PER_CONNECTION,
		})
	})

	it.each(['abc', '', '0', '-4', '2.5', String(APP_DB_POOL_SIZE_MAX + 1)])(
		'falls back to the default for DB_POOL_SIZE=%j',
		(value) => {
			expect(resolveDbPoolConfig({ DB_POOL_SIZE: value }).poolSize).toBe(APP_DB_POOL_SIZE_DEFAULT)
		},
	)

	it('takes DB_SHED_AT as an absolute count, and ignores one below the pool size', () => {
		expect(resolveDbPoolConfig({ DB_SHED_AT: '500' }).shedAt).toBe(500)
		expect(resolveDbPoolConfig({ DB_SHED_AT: '5' }).shedAt).toBe(
			APP_DB_POOL_SIZE_DEFAULT * SHED_QUERIES_PER_CONNECTION,
		)
	})
})

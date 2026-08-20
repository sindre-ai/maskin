import { describe, expect, it } from 'vitest'
import {
	isEnterpriseActor,
	isEnterpriseWorkspace,
	parseEnterpriseActorIds,
} from '../../lib/enterprise-allowlist'

const ACTOR_A = '11111111-1111-1111-1111-111111111111'
const ACTOR_B = '22222222-2222-2222-2222-222222222222'

describe('parseEnterpriseActorIds', () => {
	it('returns an empty set when unset or blank', () => {
		expect(parseEnterpriseActorIds({})).toEqual(new Set())
		expect(parseEnterpriseActorIds({ MASKIN_ENTERPRISE_ACTOR_IDS: '' })).toEqual(new Set())
	})

	it('parses a comma-separated list, trimming whitespace', () => {
		expect(
			parseEnterpriseActorIds({ MASKIN_ENTERPRISE_ACTOR_IDS: ` ${ACTOR_A} , ${ACTOR_B} ` }),
		).toEqual(new Set([ACTOR_A, ACTOR_B]))
	})

	it('lowercases entries so casing differences still match', () => {
		expect(parseEnterpriseActorIds({ MASKIN_ENTERPRISE_ACTOR_IDS: ACTOR_A.toUpperCase() })).toEqual(
			new Set([ACTOR_A]),
		)
	})

	it('drops malformed entries instead of throwing', () => {
		expect(
			parseEnterpriseActorIds({ MASKIN_ENTERPRISE_ACTOR_IDS: `${ACTOR_A},not-a-uuid,` }),
		).toEqual(new Set([ACTOR_A]))
	})
})

describe('isEnterpriseActor', () => {
	it('returns true only for an allowlisted actor id', () => {
		const env = { MASKIN_ENTERPRISE_ACTOR_IDS: ACTOR_A }
		expect(isEnterpriseActor(ACTOR_A, env)).toBe(true)
		expect(isEnterpriseActor(ACTOR_B, env)).toBe(false)
	})

	it('returns false for null/undefined actor ids', () => {
		const env = { MASKIN_ENTERPRISE_ACTOR_IDS: ACTOR_A }
		expect(isEnterpriseActor(null, env)).toBe(false)
		expect(isEnterpriseActor(undefined, env)).toBe(false)
	})

	it('returns false when the allowlist is unset', () => {
		expect(isEnterpriseActor(ACTOR_A, {})).toBe(false)
	})
})

describe('isEnterpriseWorkspace', () => {
	it('short-circuits without a DB call when the allowlist is empty', async () => {
		const db = {
			select: () => {
				throw new Error('select should not be called when the allowlist is empty')
			},
		}
		await expect(isEnterpriseWorkspace(db as never, 'ws-1', {})).resolves.toBe(false)
	})
})

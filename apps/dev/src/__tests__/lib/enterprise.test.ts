import { describe, expect, it } from 'vitest'
import {
	isEnterprise,
	isEnterpriseActor,
	isEnterpriseWorkspace,
	parseEnterpriseActorIds,
} from '../../lib/enterprise'

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
	function dbReturning(rows: unknown[]) {
		return {
			select: () => ({
				from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
			}),
		} as never
	}

	// The env-only predecessor skipped the query entirely when the allowlist was
	// empty. It can't any more: `enterprise_granted` lives in the row, so an
	// empty allowlist no longer means "nobody is enterprise" and the row has to
	// be read to answer correctly.
	it('reads the row even when the allowlist is empty, so the column can still grant', async () => {
		const db = dbReturning([{ enterpriseGranted: true, billingOwnerId: ACTOR_B }])
		await expect(isEnterpriseWorkspace(db, 'ws-1', {})).resolves.toBe(true)
	})

	it('is true for an enterprise billing owner with no per-workspace grant', async () => {
		const db = dbReturning([{ enterpriseGranted: false, billingOwnerId: ACTOR_A }])
		const env = { MASKIN_ENTERPRISE_ACTOR_IDS: ACTOR_A }
		await expect(isEnterpriseWorkspace(db, 'ws-1', env)).resolves.toBe(true)
	})

	it('is false when neither the column nor the owner grants it', async () => {
		const db = dbReturning([{ enterpriseGranted: false, billingOwnerId: ACTOR_B }])
		await expect(isEnterpriseWorkspace(db, 'ws-1', {})).resolves.toBe(false)
	})

	it('is false for a workspace that does not exist', async () => {
		await expect(isEnterpriseWorkspace(dbReturning([]), 'missing', {})).resolves.toBe(false)
	})
})

describe('isEnterprise', () => {
	const env = { MASKIN_ENTERPRISE_ACTOR_IDS: ACTOR_A }

	it('is true when the per-workspace ops grant is set, whoever owns billing', () => {
		expect(isEnterprise({ enterpriseGranted: true, billingOwnerId: ACTOR_B }, env)).toBe(true)
	})

	it('is true for an enterprise billing owner without a per-workspace grant', () => {
		expect(isEnterprise({ enterpriseGranted: false, billingOwnerId: ACTOR_A }, env)).toBe(true)
	})

	it('is false for a non-enterprise owner with no grant', () => {
		expect(isEnterprise({ enterpriseGranted: false, billingOwnerId: ACTOR_B }, env)).toBe(false)
		expect(isEnterprise({ enterpriseGranted: null, billingOwnerId: null }, env)).toBe(false)
	})

	it('ignores the allowlist entirely when it is unset', () => {
		expect(isEnterprise({ enterpriseGranted: false, billingOwnerId: ACTOR_A }, {})).toBe(false)
	})
})

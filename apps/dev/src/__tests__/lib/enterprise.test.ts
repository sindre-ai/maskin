import { describe, expect, it, vi } from 'vitest'
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

	it('is true when the workspace has the ops grant', async () => {
		const db = dbReturning([{ enterpriseGranted: true }])
		await expect(isEnterpriseWorkspace(db, 'ws-1')).resolves.toBe(true)
	})

	it('is false when the workspace has no grant', async () => {
		const db = dbReturning([{ enterpriseGranted: false }])
		await expect(isEnterpriseWorkspace(db, 'ws-1')).resolves.toBe(false)
	})

	it('is false for a workspace that does not exist', async () => {
		await expect(isEnterpriseWorkspace(dbReturning([]), 'missing')).resolves.toBe(false)
	})
})

describe('isEnterprise', () => {
	it('is true when the per-workspace ops grant is set', () => {
		expect(isEnterprise({ enterpriseGranted: true })).toBe(true)
	})

	it('is false without the grant', () => {
		expect(isEnterprise({ enterpriseGranted: false })).toBe(false)
		expect(isEnterprise({ enterpriseGranted: null })).toBe(false)
	})

	// Enterprise belongs to the workspace, not the person: an ops actor who owns
	// billing on a workspace without the flag gets a normal trial workspace.
	it('is false for a workspace owned by an ops actor when the flag is not set', () => {
		vi.stubEnv('MASKIN_ENTERPRISE_ACTOR_IDS', ACTOR_A)
		expect(isEnterprise({ enterpriseGranted: false, billingOwnerId: ACTOR_A } as never)).toBe(false)
		vi.unstubAllEnvs()
	})
})

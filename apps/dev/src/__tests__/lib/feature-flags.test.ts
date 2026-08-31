import { describe, expect, it } from 'vitest'
import { FLAGS, parseFeatureFlagConfig, resolveFlags } from '../../lib/feature-flags'

const TESTER = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const NON_TESTER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

// Most cases inject their own registry so they stay valid as flags come and go;
// one case below pins the live registry so a flag can't be dropped by accident.
const FLAG = 'sample-flag'
const REGISTRY = { SAMPLE: FLAG }

// Config is built from a plain object rather than process.env, so these tests
// never mutate the ambient environment.
function config(env: Record<string, string | undefined>) {
	return parseFeatureFlagConfig(env as NodeJS.ProcessEnv)
}

describe('parseFeatureFlagConfig', () => {
	it('defaults every list to empty when no env vars are set', () => {
		const c = config({})
		expect(c.testerActorIds.size).toBe(0)
		expect(c.testerFlags.size).toBe(0)
	})

	it('trims whitespace and drops empty entries', () => {
		const c = config({ FF_TESTER_FEATURES: ' some-flag ,, , other-flag ' })
		expect([...c.testerFlags]).toEqual(['some-flag', 'other-flag'])
	})

	it('lowercases actor ids so comparison is case-insensitive', () => {
		const c = config({ FF_TESTER_ACTOR_IDS: TESTER.toUpperCase() })
		expect(c.testerActorIds.has(TESTER)).toBe(true)
	})
})

describe('resolveFlags', () => {
	it('resolves the live registry — new-design is on for a listed tester', () => {
		const c = config({ FF_TESTER_FEATURES: FLAGS.NEW_DESIGN, FF_TESTER_ACTOR_IDS: TESTER })
		// Every registered flag is resolved on every call; every id other than the
		// one in FF_TESTER_FEATURES must default to false for a tester actor.
		const resolvedTester = resolveFlags(TESTER, c)
		expect(resolvedTester[FLAGS.NEW_DESIGN]).toBe(true)
		expect(resolvedTester[FLAGS.RICH_MARKDOWN_EDITOR]).toBe(false)
		const resolvedNonTester = resolveFlags(NON_TESTER, c)
		expect(resolvedNonTester[FLAGS.NEW_DESIGN]).toBe(false)
		expect(resolvedNonTester[FLAGS.RICH_MARKDOWN_EDITOR]).toBe(false)
	})

	it('is false for every flag when the env is empty', () => {
		expect(resolveFlags(TESTER, config({}), REGISTRY)).toEqual({ [FLAG]: false })
	})

	it('is true for a tester when the flag is in FF_TESTER_FEATURES', () => {
		const c = config({ FF_TESTER_FEATURES: FLAG, FF_TESTER_ACTOR_IDS: TESTER })
		expect(resolveFlags(TESTER, c, REGISTRY)[FLAG]).toBe(true)
	})

	it('is false for a non-tester when the flag is in FF_TESTER_FEATURES', () => {
		const c = config({ FF_TESTER_FEATURES: FLAG, FF_TESTER_ACTOR_IDS: TESTER })
		expect(resolveFlags(NON_TESTER, c, REGISTRY)[FLAG]).toBe(false)
	})

	it('matches tester actor ids case-insensitively in both directions', () => {
		const c = config({
			FF_TESTER_FEATURES: FLAG,
			FF_TESTER_ACTOR_IDS: ` ${TESTER.toUpperCase()} `,
		})
		expect(resolveFlags(TESTER, c, REGISTRY)[FLAG]).toBe(true)
		expect(resolveFlags(TESTER.toUpperCase(), c, REGISTRY)[FLAG]).toBe(true)
	})

	// There is no "on for everyone" setting by design: shipping to everyone means
	// deleting the flag, not promoting it. A leftover FF_EVERYONE in someone's
	// environment must not quietly switch a feature on for all users.
	it('ignores a legacy FF_EVERYONE var entirely', () => {
		const c = config({ FF_EVERYONE: FLAG })
		expect(resolveFlags(NON_TESTER, c, REGISTRY)[FLAG]).toBe(false)
		expect(resolveFlags(TESTER, c, REGISTRY)[FLAG]).toBe(false)
	})

	it('is false for a tester when the flag is not listed in FF_TESTER_FEATURES', () => {
		const c = config({ FF_TESTER_ACTOR_IDS: TESTER })
		expect(resolveFlags(TESTER, c, REGISTRY)[FLAG]).toBe(false)
	})

	it('ignores unknown flag ids in the env and never returns them', () => {
		const c = config({ FF_TESTER_FEATURES: 'also-fake', FF_TESTER_ACTOR_IDS: TESTER })
		const resolved = resolveFlags(TESTER, c, REGISTRY)
		expect(resolved).toEqual({ [FLAG]: false })
		expect('also-fake' in resolved).toBe(false)
	})

	it('tolerates malformed env values without throwing', () => {
		const c = config({ FF_TESTER_FEATURES: ',,,', FF_TESTER_ACTOR_IDS: '   ' })
		expect(resolveFlags(TESTER, c, REGISTRY)[FLAG]).toBe(false)
	})

	it('does not treat a whitespace-only actor id as an tester match', () => {
		const c = config({ FF_TESTER_FEATURES: FLAG, FF_TESTER_ACTOR_IDS: ' , ' })
		expect(resolveFlags('   ', c, REGISTRY)[FLAG]).toBe(false)
	})
})

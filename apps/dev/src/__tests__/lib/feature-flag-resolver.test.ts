import { describe, expect, it } from 'vitest'
import {
	FLAGS,
	type FeatureFlagConfig,
	isFlagEnabled,
	isFlagEnabledForWorkspace,
	parseFeatureFlagConfig,
} from '../../lib/feature-flags'

// Task S7 on the trigger-engine bet: `isFlagEnabledForWorkspace` supersedes
// the temporary local helper in `services/trigger-runner.ts`. This suite
// pins the OR-semantics (workspace-scoped OR actor-scoped enables), the
// FF_WORKSPACE_FEATURES parser, and the invariant that `isFlagEnabled`'s
// actor-scoped signature is untouched — the six known callers still compile
// and behave as they did before.

const WORKSPACE_A = 'e2877e32-2c11-489e-96c8-a76200908ed4'
const WORKSPACE_B = 'f79e3751-c680-47e0-9a9a-824a4a2a7908'
const TESTER = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const NON_TESTER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

// Registry injected explicitly so tests survive future additions to FLAGS.
const FLAG = 'trigger-engine-v2-fixture'
const REGISTRY = { TRIGGER_ENGINE_V2_FIXTURE: FLAG }

// Config is built from a plain object rather than process.env, so these tests
// never mutate the ambient environment.
function config(env: Record<string, string | undefined>): FeatureFlagConfig {
	return parseFeatureFlagConfig(env as NodeJS.ProcessEnv)
}

describe('parseFeatureFlagConfig — FF_WORKSPACE_FEATURES', () => {
	it('defaults workspaceFeatures to empty when the env var is unset', () => {
		expect(config({}).workspaceFeatures.size).toBe(0)
	})

	it('parses a single <workspaceId>:<flagId> entry', () => {
		const c = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}` })
		expect(c.workspaceFeatures.has(`${WORKSPACE_A.toLowerCase()}:${FLAG}`)).toBe(true)
	})

	it('parses comma-separated entries for multiple workspaces and flags', () => {
		const c = config({
			FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG},${WORKSPACE_B}:other-flag`,
		})
		expect(c.workspaceFeatures.has(`${WORKSPACE_A}:${FLAG}`)).toBe(true)
		expect(c.workspaceFeatures.has(`${WORKSPACE_B}:other-flag`)).toBe(true)
	})

	it('trims whitespace around entries and drops empties', () => {
		const c = config({
			FF_WORKSPACE_FEATURES: ` ${WORKSPACE_A}:${FLAG} ,, ,${WORKSPACE_B}:other-flag `,
		})
		expect(c.workspaceFeatures.size).toBe(2)
		expect(c.workspaceFeatures.has(`${WORKSPACE_A}:${FLAG}`)).toBe(true)
		expect(c.workspaceFeatures.has(`${WORKSPACE_B}:other-flag`)).toBe(true)
	})

	it('lowercases the workspace id half for case-insensitive comparison', () => {
		const c = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A.toUpperCase()}:${FLAG}` })
		expect(c.workspaceFeatures.has(`${WORKSPACE_A.toLowerCase()}:${FLAG}`)).toBe(true)
	})

	it('drops malformed entries without throwing', () => {
		// Missing colon, empty workspaceId, empty flagId, trailing colon, only-colon.
		const c = config({
			FF_WORKSPACE_FEATURES: `no-colon-here,:${FLAG},${WORKSPACE_A}:,:,${WORKSPACE_A}:${FLAG}`,
		})
		expect(c.workspaceFeatures.size).toBe(1)
		expect(c.workspaceFeatures.has(`${WORKSPACE_A}:${FLAG}`)).toBe(true)
	})

	it('is independent of the FF_TESTER_* pair', () => {
		const c = config({
			FF_TESTER_ACTOR_IDS: TESTER,
			FF_TESTER_FEATURES: FLAG,
			FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}`,
		})
		expect(c.testerActorIds.has(TESTER)).toBe(true)
		expect(c.testerFlags.has(FLAG)).toBe(true)
		expect(c.workspaceFeatures.has(`${WORKSPACE_A}:${FLAG}`)).toBe(true)
	})
})

describe('isFlagEnabledForWorkspace — OR semantics', () => {
	it('returns false when neither workspace nor actor is opted in', () => {
		const flagConfig = config({})
		expect(isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { flagConfig }, REGISTRY)).toBe(false)
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { actorId: TESTER, flagConfig }, REGISTRY),
		).toBe(false)
	})

	it('returns true when the workspace is listed in FF_WORKSPACE_FEATURES', () => {
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}` })
		expect(isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { flagConfig }, REGISTRY)).toBe(true)
	})

	it('returns false for a workspace not in FF_WORKSPACE_FEATURES', () => {
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}` })
		expect(isFlagEnabledForWorkspace(WORKSPACE_B, FLAG, { flagConfig }, REGISTRY)).toBe(false)
	})

	it('returns true when only the actor is a tester (actor OR)', () => {
		const flagConfig = config({
			FF_TESTER_ACTOR_IDS: TESTER,
			FF_TESTER_FEATURES: FLAG,
		})
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { actorId: TESTER, flagConfig }, REGISTRY),
		).toBe(true)
		// A non-tester actor on the same call stays false.
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { actorId: NON_TESTER, flagConfig }, REGISTRY),
		).toBe(false)
	})

	it('returns true when both workspace and actor are opted in', () => {
		const flagConfig = config({
			FF_TESTER_ACTOR_IDS: TESTER,
			FF_TESTER_FEATURES: FLAG,
			FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}`,
		})
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A, FLAG, { actorId: TESTER, flagConfig }, REGISTRY),
		).toBe(true)
	})

	it('matches workspaceId case-insensitively', () => {
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A.toUpperCase()}:${FLAG}` })
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A.toLowerCase(), FLAG, { flagConfig }, REGISTRY),
		).toBe(true)
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A.toUpperCase(), FLAG, { flagConfig }, REGISTRY),
		).toBe(true)
	})

	it('returns false for a flag id absent from the registry (typo guard)', () => {
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:not-a-real-flag` })
		expect(
			isFlagEnabledForWorkspace(WORKSPACE_A, 'not-a-real-flag', { flagConfig }, REGISTRY),
		).toBe(false)
	})

	it('resolves the live TRIGGER_ENGINE_V2 flag against the live registry', () => {
		const flagConfig = config({
			FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAGS.TRIGGER_ENGINE_V2}`,
		})
		expect(isFlagEnabledForWorkspace(WORKSPACE_A, FLAGS.TRIGGER_ENGINE_V2, { flagConfig })).toBe(
			true,
		)
		expect(isFlagEnabledForWorkspace(WORKSPACE_B, FLAGS.TRIGGER_ENGINE_V2, { flagConfig })).toBe(
			false,
		)
	})
})

describe('isFlagEnabled — actor-scoped signature is unchanged', () => {
	// The six known callers (Sales Rep autosend, Slack UX v2, LinkedIn add-on,
	// Google Meet, chats v4, graph provenance) all call isFlagEnabled with the
	// original (actorId, flagId[, config[, registry]]) shape. Assert that shape
	// still compiles and behaves as before so an accidental signature change
	// here fails the test rather than silently breaking those call sites.
	it('accepts (actorId, flagId, config, registry) and returns true for a listed tester', () => {
		const flagConfig = config({ FF_TESTER_ACTOR_IDS: TESTER, FF_TESTER_FEATURES: FLAG })
		expect(isFlagEnabled(TESTER, FLAG, flagConfig, REGISTRY)).toBe(true)
	})

	it('returns false for a non-tester actor with the same config', () => {
		const flagConfig = config({ FF_TESTER_ACTOR_IDS: TESTER, FF_TESTER_FEATURES: FLAG })
		expect(isFlagEnabled(NON_TESTER, FLAG, flagConfig, REGISTRY)).toBe(false)
	})

	it('ignores FF_WORKSPACE_FEATURES on the actor-scoped path', () => {
		// Adding a workspace-scoped enable must NOT flip isFlagEnabled true for a
		// non-tester actor — actor-scoped semantics remain unchanged.
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}` })
		expect(isFlagEnabled(NON_TESTER, FLAG, flagConfig, REGISTRY)).toBe(false)
		expect(isFlagEnabled(TESTER, FLAG, flagConfig, REGISTRY)).toBe(false)
	})
})

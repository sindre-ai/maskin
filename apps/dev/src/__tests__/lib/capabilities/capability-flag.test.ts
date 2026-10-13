import { describe, expect, it } from 'vitest'
import {
	FLAGS,
	isFlagEnabledForWorkspace,
	parseFeatureFlagConfig,
} from '../../../lib/feature-flags'

const WS = '44444444-4444-4444-8444-444444444444'
const OTHER_WS = '55555555-5555-4555-8555-555555555555'

function config(env: Record<string, string | undefined>) {
	return parseFeatureFlagConfig(env as NodeJS.ProcessEnv)
}

describe('capability-scan flag', () => {
	it('is registered as capability-scan', () => {
		expect(FLAGS.CAPABILITY_SCAN).toBe('capability-scan')
	})

	it('is off by default for every workspace', () => {
		expect(isFlagEnabledForWorkspace(WS, FLAGS.CAPABILITY_SCAN, { flagConfig: config({}) })).toBe(
			false,
		)
	})

	it('is on only for a workspace listed in FF_WORKSPACE_FEATURES', () => {
		const flagConfig = config({ FF_WORKSPACE_FEATURES: `${WS}:capability-scan` })
		expect(isFlagEnabledForWorkspace(WS, FLAGS.CAPABILITY_SCAN, { flagConfig })).toBe(true)
		expect(isFlagEnabledForWorkspace(OTHER_WS, FLAGS.CAPABILITY_SCAN, { flagConfig })).toBe(false)
	})

	it('is not turned on by a tester-actor list alone', () => {
		const flagConfig = config({
			FF_TESTER_ACTOR_IDS: '66666666-6666-4666-8666-666666666666',
			FF_TESTER_FEATURES: 'capability-scan',
		})
		expect(isFlagEnabledForWorkspace(WS, FLAGS.CAPABILITY_SCAN, { flagConfig })).toBe(false)
	})
})

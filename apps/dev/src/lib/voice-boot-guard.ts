import { FLAGS } from './feature-flags'

/**
 * Boot-time assertion for Voice v1's operator credential. When the
 * **voice-mode-v1** flag is enabled for any tester (i.e. its id appears in
 * **FF_TESTER_FEATURES**), the session-mint route calls OpenAI Realtime with
 * an operator-owned key on every mint. A missing key would 500 the first
 * time a tester clicks Call — this guard turns that into a fail-fast at
 * process start so a mis-configured deploy is visible immediately.
 *
 * Called from **apps/dev/src/index.ts** once, after the env has been read
 * and before the HTTP server binds. Pure of side effects other than the
 * throw — tests can call it with an injected env object.
 */
export function assertVoiceOperatorEnv(env: NodeJS.ProcessEnv = process.env): void {
	const testerFeatures = (env.FF_TESTER_FEATURES ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	if (!testerFeatures.includes(FLAGS.VOICE_MODE_V1)) return
	const key = env.MASKIN_VOICE_OPENAI_API_KEY?.trim()
	if (key) return
	throw new Error(
		'Voice v1 boot-guard: FF_TESTER_FEATURES contains "voice-mode-v1" but ' +
			'MASKIN_VOICE_OPENAI_API_KEY is unset. The session-mint route cannot ' +
			'mint an ephemeral OpenAI Realtime token without an operator key. ' +
			'Set MASKIN_VOICE_OPENAI_API_KEY or remove "voice-mode-v1" from FF_TESTER_FEATURES.',
	)
}

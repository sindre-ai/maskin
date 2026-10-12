/**
 * Live mode cost estimates for the audio legs. The chat leg uses OpenRouter's
 * own reported `usage.cost`. OpenRouter's audio endpoints do not return a cost
 * we can rely on yet, so these are priced from env until scripts/live-smoke.ts
 * shows what the provider reports. Treat as estimates in any billing surface.
 */
const DEFAULT_TTS_USD_PER_1K_CHARS = 0.012
const DEFAULT_STT_USD_PER_MINUTE = 0.003

function envNumber(raw: string | undefined, fallback: number): number {
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function computeTtsCostUsd(
	characters: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	return (
		(Math.max(0, characters) / 1000) *
		envNumber(env.MASKIN_LIVE_TTS_USD_PER_1K_CHARS, DEFAULT_TTS_USD_PER_1K_CHARS)
	)
}

export function computeSttCostUsd(seconds: number, env: NodeJS.ProcessEnv = process.env): number {
	return (
		(Math.max(0, seconds) / 60) *
		envNumber(env.MASKIN_LIVE_STT_USD_PER_MINUTE, DEFAULT_STT_USD_PER_MINUTE)
	)
}

const DEFAULT_DAILY_MINUTES = 60

/** Minutes of live a workspace may use per UTC day. Workspace setting wins over env. */
export function liveDailyMinuteCap(
	settings: { live?: { daily_minutes_cap?: number } } | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const fromSettings = settings?.live?.daily_minutes_cap
	if (typeof fromSettings === 'number' && Number.isFinite(fromSettings) && fromSettings > 0) {
		return fromSettings
	}
	const fromEnv = Number(env.MASKIN_LIVE_DAILY_MINUTES_PER_WORKSPACE)
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_DAILY_MINUTES
}

/**
 * Lightweight incident-density adapter.
 *
 * The shape of the input is `{ [filePath]: density }`, where density is a
 * normalized score in [0, 1]. The classifier flags top-decile files (≥0.9)
 * touched by the diff. Production code can populate this from Sentry,
 * PagerDuty, or any other incident system; the adapter is intentionally
 * data-source-agnostic so unit tests stay deterministic.
 */
import { readFileSync } from 'node:fs'

export function loadIncidentDensityFromFile(file: string): Record<string, number> {
	const raw = readFileSync(file, 'utf8')
	const parsed = JSON.parse(raw)
	if (typeof parsed !== 'object' || parsed === null) return {}
	const out: Record<string, number> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof key !== 'string') continue
		if (typeof value !== 'number' || !Number.isFinite(value)) continue
		out[key] = Math.max(0, Math.min(1, value))
	}
	return out
}

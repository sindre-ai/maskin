// Guards against NaN propagation when an operator sets a non-numeric value
// (e.g. `E2E_BUDGET_MIN=abc`). Without this, `Number(...)` becomes NaN and
// downstream arithmetic silently fails — see .claude/rules/known-pitfalls.md.
export function parseFinitePositiveEnv(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined || raw === '') return fallback
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.warn(
			`[env] invalid ${name}=${JSON.stringify(raw)}; expected a finite positive number, using default ${fallback}`,
		)
		return fallback
	}
	return parsed
}

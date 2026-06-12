// libkrun (the VMM under microsandbox) enforces two undocumented limits on
// env vars passed through `msb create -e`. Both come from the bet's
// "Hard-won operational constraints" and were learned on `feat/microsandbox`:
//   1. Values must be printable ASCII only. A Norwegian `æøå` in a value
//      panics the VMM at boot.
//   2. Values longer than ~1500 characters break the VMM handshake.
//
// We strip non-ASCII silently and spill long values into a host file that
// the entrypoint sources, so the VM never sees the offending env on the
// command line.

const OVERFLOW_THRESHOLD = 1500

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export type EnvSanitizeResult = {
	// Safe to pass via `msb create -e KEY=VALUE`.
	sanitized: Record<string, string>
	// Need to land in `${sessionDir}/.env-overflow.sh` and be sourced from the
	// entrypoint. Caller is responsible for writing the file.
	overflow: Array<{ key: string; value: string }>
}

export function sanitizeEnvForLibkrun(env: Record<string, string>): EnvSanitizeResult {
	const sanitized: Record<string, string> = {}
	const overflow: Array<{ key: string; value: string }> = []
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_KEY_RE.test(key)) {
			throw new Error(`Invalid env var key: ${JSON.stringify(key)}`)
		}
		const clean = value.replace(/[^\x20-\x7E]/g, '')
		if (clean.length > OVERFLOW_THRESHOLD) {
			overflow.push({ key, value: clean })
		} else {
			sanitized[key] = clean
		}
	}
	return { sanitized, overflow }
}

// Build the contents of `.env-overflow.sh`. Each line is a POSIX-shell-safe
// `export KEY='VALUE'` with single-quote escaping; the file is sourced from
// the microVM entrypoint to land the values in the agent process's env.
export function renderOverflowScript(overflow: Array<{ key: string; value: string }>): string {
	if (overflow.length === 0) return ''
	const lines = overflow.map(({ key, value }) => {
		const escaped = value.replace(/'/g, "'\\''")
		return `export ${key}='${escaped}'`
	})
	return `${lines.join('\n')}\n`
}

// Decides which rows apply to which client styles for a given server, runs
// them, and reports one result per (row, style). The vitest wrapper and the
// CLI both go through here, so "pending" means the same thing in both.

import { createDriver, loadSdkClient } from './drivers'
import type {
	ClientStyle,
	Driver,
	DriverOptions,
	Feature,
	Row,
	RowContext,
	RowResult,
	RunEnv,
	Target,
} from './types'
import { MODERN_VERSION, postModern, rpc } from './wire'

/**
 * Probe the server for the optional features rows can depend on. Probing the
 * server (not a build flag) is what lets one table stay valid before and after
 * the modern leg lands.
 */
export async function detectFeatures(target: Target): Promise<Set<Feature>> {
	const features = new Set<Feature>()
	try {
		await loadSdkClient()
		features.add('sdk-client')
	} catch {
		// Package not installed in this checkout: SDK rows report pending.
	}
	try {
		const discover = rpc(await postModern(target, 'server/discover'))
		const versions = discover.result?.supportedVersions
		if (Array.isArray(versions) && versions.includes(MODERN_VERSION)) features.add('modern-leg')
	} catch {
		// Not JSON or unreachable: no modern leg.
	}
	if (features.has('modern-leg')) {
		try {
			const list = rpc(await postModern(target, 'tools/list'))
			if (list.result?.ttlMs !== undefined) features.add('cache-hints')
		} catch {
			// Leave cache-hints out.
		}
	}
	return features
}

const SDK_STYLES: readonly ClientStyle[] = ['sdk-legacy', 'sdk-auto', 'sdk-modern']
const MODERN_STYLES: readonly ClientStyle[] = ['sdk-modern', 'raw-modern']

type Applicability =
	| { kind: 'run' }
	| { kind: 'n/a'; why: string }
	| { kind: 'pending'; why: string }

/** Whether a row applies to a style on this server. Pure, so it is easy to read and to test. */
export function applicability(
	row: Row,
	style: ClientStyle,
	env: RunEnv,
	features: ReadonlySet<Feature>,
): Applicability {
	if (row.flag && env.flag !== row.flag) {
		return { kind: 'n/a', why: `needs MASKIN_MCP_MODERN ${row.flag}` }
	}
	if (row.needsResponseCap && !env.responseCapTokens) {
		return { kind: 'n/a', why: 'needs a server started with a lowered MCP_RESPONSE_MAX_TOKENS' }
	}
	// A modern client is only meaningful when the flag is on; the one exception
	// is the row that checks it is refused when the flag is off.
	if (MODERN_STYLES.includes(style) && row.flag !== 'off') {
		if (env.flag === 'off') return { kind: 'n/a', why: 'modern leg is off in this run' }
		if (!features.has('modern-leg'))
			return { kind: 'pending', why: 'modern leg not on this server yet' }
	}
	const needs: Feature[] = [...(row.needs ?? [])]
	if (SDK_STYLES.includes(style)) needs.push('sdk-client')
	const missing = needs.find((feature) => !features.has(feature))
	if (missing) return { kind: 'pending', why: `needs ${missing}` }
	return { kind: 'run' }
}

export function stylesOf(row: Row): readonly ClientStyle[] {
	return row.styles
}

function makeContext(
	style: ClientStyle,
	target: Target,
	env: RunEnv,
	features: ReadonlySet<Feature>,
	open: Driver[],
): RowContext {
	const make = (forStyle: ClientStyle, options?: DriverOptions) => {
		const driver = createDriver(forStyle, target, options)
		open.push(driver)
		return driver
	}
	return {
		style,
		target,
		env,
		features,
		driver: async (options) => make(style, options),
		driverFor: async (forStyle, options) => make(forStyle, options),
	}
}

export async function runRow(
	row: Row,
	style: ClientStyle,
	target: Target,
	env: RunEnv,
	features: ReadonlySet<Feature>,
): Promise<RowResult> {
	const verdict = applicability(row, style, env, features)
	if (verdict.kind === 'n/a') return { rowId: row.id, style, status: 'n/a', detail: verdict.why }
	if (verdict.kind === 'pending') {
		return {
			rowId: row.id,
			style,
			status: env.strict ? 'fail' : 'pending',
			detail: env.strict ? `${verdict.why} (strict mode: pending is a failure)` : verdict.why,
		}
	}
	const open: Driver[] = []
	try {
		await row.run(makeContext(style, target, env, features, open))
		return { rowId: row.id, style, status: 'pass' }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return { rowId: row.id, style, status: 'fail', detail: message }
	} finally {
		// Rows close their own drivers on the happy path; this catches the failure path.
		await Promise.allSettled(open.map((driver) => driver.close()))
	}
}

export async function runMatrix(
	rows: readonly Row[],
	target: Target,
	env: RunEnv,
): Promise<{ features: Set<Feature>; results: RowResult[] }> {
	const features = await detectFeatures(target)
	const results: RowResult[] = []
	for (const row of rows) {
		for (const style of stylesOf(row)) {
			results.push(await runRow(row, style, target, env, features))
		}
	}
	return { features, results }
}

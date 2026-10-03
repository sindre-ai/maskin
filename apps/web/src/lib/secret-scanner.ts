import {
	SECRET_PATTERNS,
	type SecretMatch,
	type SecretPatternDef,
	scanForSecrets,
} from '@maskin/shared'
import posthog from 'posthog-js'

// The composer's view of the shared scanner. The pattern table and matching live in
// @maskin/shared so the server backstop applies the identical table; this file adds
// the two client-only parts: the PostHog regex override and the workspace hook.

export const SCANNER_REGEX_FLAG = 'keychain-secret-scanner-regex-v1'

const MAX_SOURCE_LENGTH = 400
// A remotely supplied regex runs on every send. Reject one that is slow on the
// inputs that hurt most before it can ever freeze the composer.
const SMOKE_BUDGET_MS = 5
// The short run of a's ending in a non-match is the classic nested-quantifier trap;
// 24 keeps the cost of detecting it to a few hundred ms instead of a hang.
const SMOKE_INPUTS = [
	`${'a'.repeat(24)}!`,
	'a'.repeat(20_000),
	`${'ab-_'.repeat(5_000)}!`,
	`${'sk-'.repeat(7_000)}`,
]

function compilesFast(source: string): boolean {
	let re: RegExp
	try {
		re = new RegExp(source, 'g')
	} catch {
		return false
	}
	for (const input of SMOKE_INPUTS) {
		const t0 = performance.now()
		input.match(re)
		if (performance.now() - t0 > SMOKE_BUDGET_MS) return false
	}
	return true
}

/**
 * Applies a flag payload on top of the compile-time table. The payload may only
 * replace the regex of a provider already in the table: it cannot add a provider,
 * change a row's confidence, or touch the allow-list. A bad row is skipped, never
 * fatal, so a broken payload leaves the shipped table in force.
 *
 * Accepted shapes: [{ id, source }] or { patterns: [{ id, source }] }.
 */
export function applyScannerPayload(payload: unknown): readonly SecretPatternDef[] {
	const rows = Array.isArray(payload)
		? payload
		: payload &&
				typeof payload === 'object' &&
				Array.isArray((payload as { patterns?: unknown }).patterns)
			? (payload as { patterns: unknown[] }).patterns
			: null
	if (!rows) return SECRET_PATTERNS
	const overrides = new Map<string, string>()
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue
		const { id, source } = row as { id?: unknown; source?: unknown }
		if (typeof id !== 'string' || typeof source !== 'string') continue
		if (source.length === 0 || source.length > MAX_SOURCE_LENGTH) continue
		if (!SECRET_PATTERNS.some((p) => p.id === id)) continue
		if (!compilesFast(source)) continue
		overrides.set(id, source)
	}
	if (overrides.size === 0) return SECRET_PATTERNS
	return SECRET_PATTERNS.map((p) =>
		overrides.has(p.id) ? { ...p, source: overrides.get(p.id) as string } : p,
	)
}

let cachedPayload: unknown
let cachedTable: readonly SecretPatternDef[] = SECRET_PATTERNS

/** Reads the flag payload each call (cheap) and recompiles only when it changed. */
export function currentScannerTable(): readonly SecretPatternDef[] {
	let payload: unknown
	try {
		payload = posthog.getFeatureFlagPayload(SCANNER_REGEX_FLAG)
	} catch {
		// Analytics must never break the composer: fall back to the shipped table.
		return SECRET_PATTERNS
	}
	if (payload === undefined || payload === null) return SECRET_PATTERNS
	if (payload !== cachedPayload) {
		cachedPayload = payload
		cachedTable = applyScannerPayload(payload)
	}
	return cachedTable
}

/**
 * Workspace allow-or-deny hook. Today it is a passthrough: every pattern applies to
 * every workspace. It exists so an enterprise deny-list can slot in without touching
 * the call sites.
 */
export function isPatternEnabledForWorkspace(_workspaceId: string, _patternId: string): boolean {
	return true
}

export interface ComposerScanOptions {
	workspaceId: string
	/** Pattern ids muted for this session by "Not a secret". */
	mutedPatternIds?: ReadonlySet<string>
}

export function scanComposerText(text: string, opts: ComposerScanOptions): SecretMatch[] {
	const table = currentScannerTable().filter((p) =>
		isPatternEnabledForWorkspace(opts.workspaceId, p.id),
	)
	return scanForSecrets(text, { table, mutedPatternIds: opts.mutedPatternIds })
}

/** True when the text holds a block-the-send match. Used to keep drafts out of storage. */
export function hasHighConfidenceSecret(text: string, workspaceId: string): boolean {
	return scanComposerText(text, { workspaceId }).some((m) => m.confidence === 'high')
}

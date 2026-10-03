// Shared by the web composer guard and the server backstop so both sides agree on
// what counts as a pasted secret. High-confidence patterns block the send; the
// low-confidence ones only raise the amber "is this a secret?" card.

export const SECRET_PROVIDER_IDS = [
	'cloudflare',
	'github',
	'stripe',
	'slack',
	'openai-style',
] as const
export type SecretProviderId = (typeof SECRET_PROVIDER_IDS)[number]

export type SecretConfidence = 'high' | 'low'

export interface SecretPatternDef {
	id: string
	confidence: SecretConfidence
	/** Set on high-confidence patterns; the allow-list for chat-capture. */
	provider: SecretProviderId | null
	source: string
	/** Card copy, for example "a Cloudflare API token". */
	description: string
}

/** Detection table, tech spec 5.4. Order matters: on equal length the earlier row wins. */
export const SECRET_PATTERNS: readonly SecretPatternDef[] = [
	{
		id: 'stripe',
		confidence: 'high',
		provider: 'stripe',
		source: '\\bsk_(?:live|test)_[A-Za-z0-9]{24,}',
		description: 'a Stripe secret key',
	},
	{
		id: 'cloudflare',
		confidence: 'high',
		provider: 'cloudflare',
		source: '\\b(?:cfut|cfat|cfk)_[A-Za-z0-9]{40,64}\\b',
		description: 'a Cloudflare API token',
	},
	{
		id: 'github',
		confidence: 'high',
		provider: 'github',
		source: '\\bghp_[A-Za-z0-9]{36}\\b|\\bgithub_pat_[A-Za-z0-9_]{82}\\b',
		description: 'a GitHub personal access token',
	},
	{
		id: 'slack',
		confidence: 'high',
		provider: 'slack',
		source: '\\bxox[bp]-[A-Za-z0-9-]{20,}',
		description: 'a Slack token',
	},
	{
		id: 'openai-style',
		confidence: 'high',
		provider: 'openai-style',
		source: '\\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}',
		description: 'an API key with a service-secret prefix',
	},
	{
		id: 'cf-ray',
		confidence: 'low',
		provider: null,
		source: '\\b[0-9a-f]{16}-[A-Z]{3}\\b',
		description: 'a long string that might be a secret',
	},
	{
		id: 'long-blob',
		confidence: 'low',
		provider: null,
		source: '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])',
		description: 'a long string that might be a secret',
	},
]

export interface SecretMatch {
	patternId: string
	provider: SecretProviderId | null
	confidence: SecretConfidence
	description: string
	start: number
	end: number
	value: string
}

export interface ScanOptions {
	table?: readonly SecretPatternDef[]
	/** Pattern ids the user marked "not a secret" this session. */
	mutedPatternIds?: ReadonlySet<string>
	/** Skip the amber patterns (server backstop only blocks on high confidence). */
	highOnly?: boolean
}

const compiled = new WeakMap<readonly SecretPatternDef[], Map<string, RegExp>>()

function regexFor(table: readonly SecretPatternDef[], def: SecretPatternDef): RegExp {
	let byId = compiled.get(table)
	if (!byId) {
		byId = new Map()
		compiled.set(table, byId)
	}
	let re = byId.get(def.id)
	if (!re) {
		re = new RegExp(def.source, 'g')
		byId.set(def.id, re)
	}
	re.lastIndex = 0
	return re
}

/**
 * Non-overlapping matches in text order. High-confidence matches are placed first
 * (longest wins, then table order) and the amber patterns only fill what is left,
 * so a Stripe key is never also reported as a long blob.
 */
export function scanForSecrets(text: string, opts: ScanOptions = {}): SecretMatch[] {
	const table = opts.table ?? SECRET_PATTERNS
	const muted = opts.mutedPatternIds
	// Muted matches still claim their span, so "not a secret" on a GitHub token
	// does not make the same text come back as an amber long-blob card.
	const taken: SecretMatch[] = []
	const hidden: SecretMatch[] = []
	const overlaps = (s: number, e: number) =>
		[...taken, ...hidden].some((m) => s < m.end && e > m.start)

	for (const confidence of ['high', 'low'] as const) {
		if (confidence === 'low' && opts.highOnly) break
		const candidates: Array<SecretMatch & { order: number }> = []
		table.forEach((def, order) => {
			if (def.confidence !== confidence) return
			for (const m of text.matchAll(regexFor(table, def))) {
				const start = m.index ?? 0
				candidates.push({
					patternId: def.id,
					provider: def.provider,
					confidence,
					description: def.description,
					start,
					end: start + m[0].length,
					value: m[0],
					order,
				})
			}
		})
		candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order)
		for (const { order: _order, ...c } of candidates) {
			if (overlaps(c.start, c.end)) continue
			if (muted?.has(c.patternId)) hidden.push(c)
			else taken.push(c)
		}
	}
	return taken.sort((a, b) => a.start - b.start)
}

export function findHighConfidenceSecret(
	text: string,
	table: readonly SecretPatternDef[] = SECRET_PATTERNS,
): SecretMatch | null {
	return scanForSecrets(text, { table, highOnly: true })[0] ?? null
}

const PREFIX_RE =
	/^(?:(?:cfut|cfat|cfk|ghp|github_pat|sk_live|sk_test)_|xox[bp]-|sk-(?:proj-|svcacct-)?)/

/** For example cfut_[REDACTED · vaulted as NAME]. The marker never matches a pattern. */
export function redactionMarker(secret: string, name: string): string {
	const prefix = PREFIX_RE.exec(secret)?.[0] ?? ''
	return `${prefix}[REDACTED · vaulted as ${name}]`
}

export function redactSecrets(text: string, matches: readonly SecretMatch[], name: string): string {
	let out = ''
	let cursor = 0
	for (const m of [...matches].sort((a, b) => a.start - b.start)) {
		out += text.slice(cursor, m.start) + redactionMarker(m.value, name)
		cursor = m.end
	}
	return out + text.slice(cursor)
}

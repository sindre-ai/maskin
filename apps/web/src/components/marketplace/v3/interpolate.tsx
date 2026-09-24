/**
 * Placeholder + inline-bold resolution for `install_flow_copy` strings.
 *
 * The catalog endpoint serves per-item strings that may embed the four
 * placeholder tokens `{integration}`, `{team}`, `{agents}`, `{trigger_count}`
 * (design spec §Copy). Some strings additionally include `**bold**` spans so
 * the two seed exemplars — Granola and Churn Recovery — render with the same
 * visible emphasis they carried as hardcoded literals in install-modal.tsx.
 *
 * `interpolateInstallFlowCopy` handles both in one pass and returns a
 * `ReactNode` (string or fragment) so the caller can drop the result into
 * JSX without dangerouslySetInnerHTML. Unresolved tokens log a warning once
 * per token per session and render as the raw token — visible-but-non-fatal
 * so QA catches the gap without paging anyone.
 */

import type { ReactNode } from 'react'

export interface InterpolationContext {
	integration?: string
	team?: string
	agents?: string
	trigger_count?: string | number
}

const TOKEN_KEYS = ['integration', 'team', 'agents', 'trigger_count'] as const
type TokenKey = (typeof TOKEN_KEYS)[number]

const warnedTokens = new Set<string>()

function warnUnresolved(token: TokenKey, source: string): void {
	const key = `${token}::${source}`
	if (warnedTokens.has(key)) return
	warnedTokens.add(key)
	// eslint-disable-next-line no-console
	console.warn(`[marketplace] install_flow_copy: unresolved placeholder {${token}} in "${source}"`)
}

/**
 * Test-only helper — resets the warning dedup set so a test can exercise the
 * warning path multiple times.
 */
export function __resetInterpolationWarnCacheForTests(): void {
	warnedTokens.clear()
}

/**
 * Resolve `{placeholder}` tokens against `ctx`. Renders `**bold**` spans as
 * `<strong>` elements. Returns a React node so JSX can consume it directly.
 */
export function interpolateInstallFlowCopy(
	template: string | undefined,
	ctx: InterpolationContext = {},
): ReactNode {
	if (!template) return null

	// Resolve placeholder tokens first — this keeps the bold-parsing regex
	// working on the resolved output (e.g. if `{agents}` maps to a bold span
	// itself, it stays plain text here and is not re-parsed).
	const resolved = template.replace(/\{(integration|team|agents|trigger_count)\}/g, (_, raw) => {
		const key = raw as TokenKey
		const value = ctx[key]
		if (value === undefined || value === null || value === '') {
			warnUnresolved(key, template)
			return `{${key}}`
		}
		return String(value)
	})

	// Split on **bold** — even indices are plain text, odd are bold spans.
	// Keys are derived from the split output plus a running position so the
	// list stays stable even if the same bold text appears twice in one
	// template (biome flags bare indices as fragile keys).
	const parts = resolved.split(/\*\*(.+?)\*\*/g)
	if (parts.length === 1) return resolved
	let cursor = 0
	return parts.map((part, i) => {
		const start = cursor
		cursor += part.length + (i % 2 === 1 ? 4 : 0) // account for the `**` markers we stripped
		const key = `${i % 2 === 1 ? 'b' : 't'}:${start}:${part.length}`
		return i % 2 === 1 ? <strong key={key}>{part}</strong> : <span key={key}>{part}</span>
	}) as ReactNode
}

import type { WorkspaceWithRole } from './api'

const WILDCARD = '*'

interface Allowlist {
	wildcard: boolean
	ids: Set<string>
}

function parseAllowlist(raw: string | undefined): Allowlist {
	if (!raw) return { wildcard: false, ids: new Set() }
	const entries = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
	if (entries.includes(WILDCARD)) return { wildcard: true, ids: new Set() }
	return { wildcard: false, ids: new Set(entries) }
}

// Founders-only gate for the For You sparse-state composer (bet
// `foryou-sparse-composer`, `## First test`). The composer ships behind this
// flag so only the `sebk` and `magnus` workspaces see it for the first week —
// if neither founder uses it with a sparse feed, the bet is abandoned before
// broader instrumentation. Mirrors the `VITE_POSTHOG_KEY` env-var pattern; the
// workspace `name` field is user-mutable so name-based gating would be fragile.
// `*` enables every workspace and is used by the e2e build to keep AC-U1/U2/U4
// specs green without baking a specific workspace UUID into CI.
export function isForyouSparseComposerEnabled(workspace: Pick<WorkspaceWithRole, 'id'>): boolean {
	const { wildcard, ids } = parseAllowlist(import.meta.env.VITE_FORYOU_COMPOSER_WORKSPACES)
	if (wildcard) return true
	return ids.has(workspace.id.toLowerCase())
}

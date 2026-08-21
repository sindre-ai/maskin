const BASE = 'http://localhost:5173'

/**
 * Every workspace is created on the `trial` tier, which caps an actor at ONE
 * human seat and ONE owned workspace (`SEAT_CAPS` / `OWNERSHIP_CAPS` in
 * packages/shared/src/billing-caps.ts). Specs that legitimately need a second
 * member or a second workspace must first put the account on a tier with
 * headroom — otherwise the create/add call 403s. See PR #970.
 */
export async function grantPlanHeadroom(
	apiKey: string,
	workspaceId: string,
	plan: 'pro' | 'team' = 'team',
) {
	const res = await fetch(`${BASE}/api/workspaces/${workspaceId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ settings: { billing: { plan, status: 'active' } } }),
	})
	if (!res.ok) {
		throw new Error(`Grant plan headroom failed: ${res.status} ${await res.text()}`)
	}
}

/**
 * Workspaces default to `byollm_allowed: false` — the Maskin-provided LLM
 * plan. Only ops-flagged exception workspaces may bring their own Claude
 * subscription / API key / custom endpoint, so specs that drive those controls
 * must grant the entitlement first. See PR #970.
 */
export async function grantByollmAllowed(apiKey: string, workspaceId: string) {
	const res = await fetch(`${BASE}/api/workspaces/admin/${workspaceId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ byollm_allowed: true }),
	})
	if (!res.ok) {
		throw new Error(`Grant byollm_allowed failed: ${res.status} ${await res.text()}`)
	}
}

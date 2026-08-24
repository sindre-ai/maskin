const BASE = 'http://localhost:5173'

/**
 * Neither grant below is self-service in the product: `settings.billing` is
 * rejected by PATCH /api/workspaces/:id (Stripe owns it) and `byollm_allowed`
 * requires an ops actor on MASKIN_ENTERPRISE_ACTOR_IDS. E2E actors are created
 * through public signup with server-generated UUIDs, so they can't be on that
 * allowlist. `POST /api/test-grants/:id` is the seam — it only exists on stacks
 * that set MASKIN_TEST_GRANT_TOKEN. See apps/dev/src/routes/test-grants.ts.
 */
const TEST_GRANT_TOKEN = process.env.MASKIN_TEST_GRANT_TOKEN

async function testGrant(
	apiKey: string,
	workspaceId: string,
	body: { plan?: 'trial' | 'pro' | 'team'; byollm_allowed?: boolean },
	what: string,
) {
	if (!TEST_GRANT_TOKEN) {
		throw new Error(
			`${what} needs MASKIN_TEST_GRANT_TOKEN set for both the E2E run and the API stack — without it POST /api/test-grants is not mounted.`,
		)
	}
	const res = await fetch(`${BASE}/api/test-grants/${workspaceId}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'X-Test-Grant-Token': TEST_GRANT_TOKEN,
		},
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		throw new Error(`${what} failed: ${res.status} ${await res.text()}`)
	}
}

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
	await testGrant(apiKey, workspaceId, { plan }, 'Grant plan headroom')
}

/**
 * Workspaces default to `byollm_allowed: false` — the Maskin-provided LLM
 * plan. Only ops-flagged exception workspaces may bring their own Claude
 * subscription / API key / custom endpoint, so specs that drive those controls
 * must grant the entitlement first. See PR #970.
 */
export async function grantByollmAllowed(apiKey: string, workspaceId: string) {
	await testGrant(apiKey, workspaceId, { byollm_allowed: true }, 'Grant byollm_allowed')
}

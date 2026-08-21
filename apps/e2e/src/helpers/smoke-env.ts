export interface SmokeConfig {
	email: string
	password: string
	workspaceId: string
}

/**
 * Smoke mode targets a permanent, pre-provisioned tenant on a live deployment
 * instead of signing up a throwaway actor per test. It is enabled only when all
 * three vars are present, so local runs and the `verify-e2e` CI job — which set
 * none of them — are entirely unaffected.
 *
 * This module deliberately has no imports: `api.helper.ts` depends on the smoke
 * ledger, so anything the ledger needs must not import back into `api.helper`.
 */
export function getSmokeConfig(): SmokeConfig | null {
	const email = process.env.SMOKE_LOGIN_EMAIL
	const password = process.env.SMOKE_LOGIN_PASSWORD
	const workspaceId = process.env.SMOKE_WORKSPACE_ID
	if (!email || !password || !workspaceId) return null
	return { email, password, workspaceId }
}

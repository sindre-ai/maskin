import { createDb } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'

// The backend intentionally never returns the email-change verification token
// in the `POST /api/auth/email-change` response body — the token itself proves
// ownership of the new address, so handing it back over the same authenticated
// channel would defeat the point. In dev it's only surfaced via a
// `[email-change] verification URL minted` log line (see apps/dev/src/routes/auth.ts).
// For e2e we need the *real* token (not a mock) to drive the actual /verify-email
// page, so we read it directly from the `actors` row it was written to — the
// same real Postgres the running dev stack already uses. This mirrors the
// backend integration-test pattern of connecting to a real DB (see
// apps/dev/src/__tests__/integration/global-setup.ts), just from the e2e side.

let dbInstance: ReturnType<typeof createDb> | null = null

function getDb() {
	if (!dbInstance) {
		const url = process.env.DATABASE_URL
		if (!url) {
			throw new Error(
				'DATABASE_URL is required to read the real email-change verification token in e2e tests. ' +
					'Make sure the dev stack is running (`pnpm dev:win` / `pnpm dev`) and DATABASE_URL is set ' +
					'in the environment running Playwright.',
			)
		}
		dbInstance = createDb(url)
	}
	return dbInstance
}

/**
 * Reads the pending email-change verification token for `actorId` straight
 * from Postgres. Call this right after `TestAPI.requestEmailChange()` — the
 * request route mints and persists the token synchronously before responding,
 * so there's no race to poll for.
 */
export async function getPendingEmailToken(actorId: string): Promise<string> {
	const db = getDb()
	const [row] = await db
		.select({ pendingEmailToken: actors.pendingEmailToken })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)

	if (!row?.pendingEmailToken) {
		throw new Error(`No pending email-change verification token found for actor ${actorId}`)
	}

	return row.pendingEmailToken
}

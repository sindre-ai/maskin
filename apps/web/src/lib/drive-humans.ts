import type { IntegrationResponse } from '@/lib/api'

/** Providers that sign a human in with Google. Drive is its own OAuth client
 *  (ADR-006), so a Google row is evidence the human has a Google account here,
 *  not that Drive is connected. */
export const GOOGLE_FAMILY_PROVIDERS = [
	'gmail',
	'google-calendar',
	'google-meet',
	'google-drive',
] as const

export const DRIVE_PROVIDER = 'google-drive'

/** The scopes the Drive detail page reports per human. v1 requests the single
 *  drive scope; adding one later is a row here plus its copy. */
export const DRIVE_SCOPES: readonly { scope: string; label: string; sublabel: string }[] = [
	{
		scope: 'https://www.googleapis.com/auth/drive',
		label: 'Edit & comment on any file',
		sublabel: 'drive',
	},
]

export type DriveHumanState = 'connected' | 'needs-reconnect' | 'add-drive'

export interface DriveHuman {
	/** Lower-cased Google email, the identity a human has across Google rows. */
	email: string
	/** Member who connected one of this human's rows, when the row records one. */
	actorId: string | null
	state: DriveHumanState
	/** Scope URLs on the Drive row's token response; empty with no Drive row. */
	grantedScopes: string[]
	driveIntegrationId: string | null
}

/** Page-level variant, picked from the humans. */
export type DriveDetailVariant = 'scope-add' | 'connected' | 'needs-reconnect' | 'all-disconnected'

function isGoogleFamily(provider: string): boolean {
	return (GOOGLE_FAMILY_PROVIDERS as readonly string[]).includes(provider)
}

/** The distinct Google accounts across the workspace's Google-family rows, each
 *  with the state of that account's Drive connection. */
export function deriveDriveHumans(integrations: IntegrationResponse[]): DriveHuman[] {
	const byEmail = new Map<string, DriveHuman>()

	for (const row of integrations) {
		if (!isGoogleFamily(row.provider) || !row.externalId) continue
		const isDrive = row.provider === DRIVE_PROVIDER
		// A Drive row that is revoked or errored means nothing is connected; a
		// non-Drive row only counts as a Google sign-in while it is active.
		if (isDrive ? row.status !== 'active' && row.status !== 'error' : row.status !== 'active') {
			continue
		}

		const email = row.externalId.toLowerCase()
		const human: DriveHuman = byEmail.get(email) ?? {
			email,
			actorId: row.actorId,
			state: 'add-drive',
			grantedScopes: [],
			driveIntegrationId: null,
		}
		human.actorId = human.actorId ?? row.actorId

		if (isDrive) {
			human.driveIntegrationId = row.id
			human.grantedScopes = row.grantedScopes ?? []
			human.state = row.status === 'error' || row.needsReconnect ? 'needs-reconnect' : 'connected'
		}
		byEmail.set(email, human)
	}

	return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

export function pickDriveVariant(humans: DriveHuman[]): DriveDetailVariant {
	if (humans.length === 0) return 'all-disconnected'
	if (humans.some((h) => h.state === 'needs-reconnect')) return 'needs-reconnect'
	if (humans.some((h) => h.state === 'add-drive')) return 'scope-add'
	return 'connected'
}

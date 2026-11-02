// Everything the demo-shots job is allowed to touch. The job only ever works inside the
// Maskin Demo workspace; the one exception is uploading the finished PNGs to the main
// workspace's files (see upload.ts), which has its own constant and its own key.

export const DEMO_WORKSPACE_ID = '6758b11a-fe63-4f48-9688-074adbaf6ccc'
export const DEMO_WORKSPACE_NAME = 'Maskin Demo'
export const MAIN_WORKSPACE_ID = 'e2877e32-2c11-489e-96c8-a76200908ed4'

export const APP_URL = (process.env.DEMO_APP_URL ?? 'https://maskin.io').replace(/\/$/, '')
export const API_URL = `${APP_URL}/api`

/** Metadata flag on every seeded object, so demo data is recognisable and findable. */
export const DEMO_FLAG = 'demo_data'
/** Metadata key that gives each seeded object a stable identity for idempotent reruns. */
export const DEMO_KEY = 'demo_key'

export function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing environment variable ${name}`)
	return value
}

/**
 * The demo account's login. The Keychain secrets "Maskin Demo email" and "Maskin Demo password"
 * arrive as KEYCHAIN_BYO_APIKEY_MASKIN_DEMO_EMAIL / _PASSWORD; DEMO_EMAIL and DEMO_PASSWORD
 * override them. The values are never logged, and the error names only the variables.
 */
export function demoCredentials(): { email: string; password: string } {
	const email = process.env.DEMO_EMAIL || process.env.KEYCHAIN_BYO_APIKEY_MASKIN_DEMO_EMAIL
	const password = process.env.DEMO_PASSWORD || process.env.KEYCHAIN_BYO_APIKEY_MASKIN_DEMO_PASSWORD
	if (!email || !password) {
		throw new Error(
			'Missing demo login: set DEMO_EMAIL and DEMO_PASSWORD, or share the Keychain secrets "Maskin Demo email" and "Maskin Demo password" with this agent',
		)
	}
	return { email, password }
}

/** Hard check: nothing is read or written unless the workspace is the demo workspace. */
export function assertDemoWorkspace(workspaceId: string): void {
	if (workspaceId !== DEMO_WORKSPACE_ID) {
		throw new Error(`Refusing to run against workspace ${workspaceId}: not the demo workspace`)
	}
}

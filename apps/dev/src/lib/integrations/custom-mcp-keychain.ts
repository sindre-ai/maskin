import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { byoApiKeyEnvName, byoLoginEnvNames } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { decodeLogin } from './byo-login'
import type { CustomMcpServer } from './custom-mcp'
import {
	CredentialNotFoundError,
	CredentialPendingError,
	CredentialUnavailableError,
	CredentialUndoneError,
	ScopeDeniedError,
} from './errors'
import { getCredential } from './lookup'

/**
 * A custom tool server's env and header values may point at a saved Keychain credential
 * instead of holding a secret: `Bearer ${KEYCHAIN_BYO_APIKEY_STRIPE}`. The reference is
 * stored; the secret never is. It is filled in at the last moment:
 *  - an HTTP server behind the gateway: by Maskin, per call, so the agent never sees it;
 *  - a server that runs in the container: by envsubst, from the env the Keychain injects.
 * Either way the credential's own access list decides who gets it, and every read is audited.
 */

const BRACED = /\$\{(KEYCHAIN_[A-Za-z0-9_]*)\}/g
const ANY = /\$\{?(KEYCHAIN_[A-Za-z0-9_]*)/g

function valuesOf(server: CustomMcpServer): string[] {
	return [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
}

/** The KEYCHAIN_ variables the server's env and header values name, in `${...}` form. */
export function referencedVars(server: CustomMcpServer): string[] {
	const names = new Set<string>()
	for (const value of valuesOf(server)) {
		for (const m of value.matchAll(BRACED)) names.add(m[1] as string)
	}
	return [...names]
}

/**
 * Keychain references in a place they must not be: the command, its args, the URL, a
 * variable or header name, or an unbraced `$KEYCHAIN_X` in a value. A command could print
 * its own argument, and a URL would put the secret in a request line.
 */
export function misplacedReferences(server: CustomMcpServer): string[] {
	const names = new Set<string>()
	const scan = (text: string) => {
		for (const m of text.matchAll(ANY)) names.add(m[1] as string)
	}
	scan(
		JSON.stringify({
			command: server.command ?? '',
			args: server.args ?? [],
			url: server.url ?? '',
			envKeys: Object.keys(server.env ?? {}),
			headerKeys: Object.keys(server.headers ?? {}),
		}),
	)
	for (const value of valuesOf(server)) scan(value.replace(BRACED, ''))
	return [...names]
}

export interface CredentialEntry {
	integrationId: string
	displayName: string
	kind: 'api_key' | 'login'
	/** Which part of a login the variable holds. An API key has one value. */
	field: 'value' | 'username' | 'password' | 'email'
	createdBy: string
}

/** Every saved credential in the workspace by the env var name that refers to it. */
export async function credentialIndex(
	db: Database,
	workspaceId: string,
): Promise<Map<string, CredentialEntry>> {
	const rows = await db
		.select({
			id: integrations.id,
			displayName: integrations.displayName,
			providerMode: integrations.providerMode,
			createdBy: integrations.createdBy,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				inArray(integrations.providerMode, ['byo_apikey', 'byo_login']),
				inArray(integrations.status, ['active', 'pending_undo']),
			),
		)
	const index = new Map<string, CredentialEntry>()
	for (const r of rows) {
		if (!r.displayName) continue
		const base = { integrationId: r.id, displayName: r.displayName, createdBy: r.createdBy }
		if (r.providerMode === 'byo_login') {
			const names = byoLoginEnvNames(r.displayName)
			if (!names) continue
			index.set(names.username, { ...base, kind: 'login', field: 'username' })
			index.set(names.password, { ...base, kind: 'login', field: 'password' })
			index.set(names.email, { ...base, kind: 'login', field: 'email' })
		} else {
			const name = byoApiKeyEnvName(r.displayName)
			if (name) index.set(name, { ...base, kind: 'api_key', field: 'value' })
		}
	}
	return index
}

export class KeychainReferenceError extends Error {}

export interface ReferenceContext {
	workspaceId: string
	actorId: string
	conversationId?: string | null
	sessionId?: string | null
	/** For the message an agent reads. */
	serverLabel: string
	outboundTarget?: string
}

/**
 * Fills the `${KEYCHAIN_...}` references in a set of header values, reading each credential
 * as the calling agent: its grants apply and the read is audited. Throws a message an agent
 * can act on when a credential is not usable, never a value.
 */
export async function fillKeychainReferences(
	db: Database,
	ctx: ReferenceContext,
	values: Record<string, string>,
): Promise<Record<string, string>> {
	const wanted = new Set<string>()
	for (const v of Object.values(values))
		for (const m of v.matchAll(BRACED)) wanted.add(m[1] as string)
	if (wanted.size === 0) return values

	const index = await credentialIndex(db, ctx.workspaceId)
	const filled = new Map<string, string>()
	for (const name of wanted) {
		const entry = index.get(name)
		if (!entry) {
			throw new KeychainReferenceError(
				`${ctx.serverLabel} uses a saved credential that no longer exists (${name}). Ask a person to update the tool server under Settings → Integrations.`,
			)
		}
		try {
			const credential = await getCredential(db, ctx.workspaceId, entry.integrationId, {
				requestingActorId: ctx.actorId,
				conversationId: ctx.conversationId,
				sessionId: ctx.sessionId,
				outboundTarget: ctx.outboundTarget,
				requestId: `custom-mcp:${entry.integrationId}:${crypto.randomUUID()}`,
			})
			if (entry.kind === 'login') {
				const login = decodeLogin(credential.value)
				if (!login) throw new KeychainReferenceError(`${entry.displayName} is not a usable login.`)
				const part = login[entry.field as 'username' | 'password' | 'email']
				if (part === undefined) {
					throw new KeychainReferenceError(`${entry.displayName} has no email saved.`)
				}
				filled.set(name, part)
			} else {
				filled.set(name, credential.value)
			}
		} catch (err) {
			if (err instanceof KeychainReferenceError) throw err
			if (err instanceof ScopeDeniedError) {
				throw new KeychainReferenceError(
					`${ctx.serverLabel} needs the "${entry.displayName}" credential, which you can't use yet. If the task needs it, call list_keychain_credentials and request_keychain_access so a person can allow it.`,
				)
			}
			if (
				err instanceof CredentialNotFoundError ||
				err instanceof CredentialUndoneError ||
				err instanceof CredentialPendingError ||
				err instanceof CredentialUnavailableError
			) {
				throw new KeychainReferenceError(
					`The "${entry.displayName}" credential that ${ctx.serverLabel} uses is not available any more.`,
				)
			}
			throw err
		}
	}
	return Object.fromEntries(
		Object.entries(values).map(([k, v]) => [
			k,
			v.replace(BRACED, (_m, name: string) => filled.get(name) ?? ''),
		]),
	)
}

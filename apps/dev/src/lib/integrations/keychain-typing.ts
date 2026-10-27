import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { byoLoginEnvNames } from '@maskin/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { decodeLogin } from './byo-login'
import {
	CredentialNotFoundError,
	CredentialPendingError,
	CredentialUnavailableError,
	CredentialUndoneError,
	ScopeDeniedError,
} from './errors'
import { getCredential } from './lookup'

/**
 * An agent types a saved login into its computer without ever reading it: it sends
 * `{{keychain:Facebook.password}}` as the text of `desktop_type`, and Maskin swaps in the
 * real value on the way to the computer. The reference must be the WHOLE text. Anything
 * longer is refused, so a page cannot talk the agent into wrapping a secret in text that
 * shows or leaks it. The credential's own access list decides who may use it, and every
 * read is audited by getCredential.
 */

const PLACEHOLDER = /^\{\{keychain:([^{}]+)\.(username|password)\}\}$/
const MENTIONS_PLACEHOLDER = /\{\{\s*keychain:/i

export type KeychainTyping =
	| { kind: 'plain' }
	| { kind: 'resolved'; text: string; credentialName: string; field: 'username' | 'password' }
	| { kind: 'error'; status: 400 | 403 | 404; message: string }

export interface KeychainTypingContext {
	workspaceId: string
	actorId: string
	/** Only an agent may type a saved credential; a person has the keyboard of their own. */
	actorType?: string
	sessionId?: string | null
	conversationId?: string | null
}

export async function resolveKeychainTyping(
	db: Database,
	ctx: KeychainTypingContext,
	text: string,
): Promise<KeychainTyping> {
	const match = PLACEHOLDER.exec(text)
	if (!match) {
		if (MENTIONS_PLACEHOLDER.test(text)) {
			return {
				kind: 'error',
				status: 400,
				message:
					'A saved credential must be typed on its own: send exactly {{keychain:<Name>.username}} or {{keychain:<Name>.password}} as the whole text, with nothing before or after it. Nothing was typed.',
			}
		}
		return { kind: 'plain' }
	}

	const name = (match[1] as string).trim()
	const field = match[2] as 'username' | 'password'
	if (ctx.actorType !== 'agent') {
		return {
			kind: 'error',
			status: 403,
			message: 'Only an agent can type a saved credential. Nothing was typed.',
		}
	}

	// Names are matched by slug, so "Face-book" and "Facebook" are the same login to the
	// lookup. Never guess between them: typing the other account's password is worse than
	// typing nothing.
	const slug = byoLoginEnvNames(name)?.username
	const rows = slug
		? (
				await db
					.select({
						id: integrations.id,
						displayName: integrations.displayName,
						config: integrations.config,
					})
					.from(integrations)
					.where(
						and(
							eq(integrations.workspaceId, ctx.workspaceId),
							eq(integrations.providerMode, 'byo_login'),
							inArray(integrations.status, ['active', 'pending_undo']),
						),
					)
					.orderBy(asc(integrations.createdAt))
			).filter((r) => r.displayName && byoLoginEnvNames(r.displayName)?.username === slug)
		: []
	if (rows.length > 1) {
		return {
			kind: 'error',
			status: 400,
			message: `More than one saved login matches "${name}" (${rows.map((r) => `"${r.displayName}"`).join(', ')}). Ask the user to rename one so the name is unique. Nothing was typed.`,
		}
	}
	const row = rows[0]
	const entry = row ? { integrationId: row.id, displayName: row.displayName as string } : undefined
	if (!entry) {
		return {
			kind: 'error',
			status: 404,
			message: `There is no saved login called "${name}". Call list_keychain_credentials for the exact names, or request_keychain_credential to ask the user to add it. Nothing was typed.`,
		}
	}

	// The owner's switch for agents applies here as it does to every other way an agent
	// reaches a credential.
	if (
		(row?.config as { expose_to_agent_sessions?: boolean } | null)?.expose_to_agent_sessions ===
		false
	) {
		return {
			kind: 'error',
			status: 403,
			message: `The "${entry.displayName}" login is switched off for agent sessions. Nothing was typed.`,
		}
	}

	try {
		const credential = await getCredential(db, ctx.workspaceId, entry.integrationId, {
			requestingActorId: ctx.actorId,
			conversationId: ctx.conversationId,
			sessionId: ctx.sessionId,
			outboundTarget: 'desktop:type',
			requestId: `desktop-type:${entry.integrationId}:${crypto.randomUUID()}`,
		})
		const login = decodeLogin(credential.value)
		if (!login) {
			return {
				kind: 'error',
				status: 404,
				message: `"${entry.displayName}" is not a usable login. Nothing was typed.`,
			}
		}
		return {
			kind: 'resolved',
			text: login[field],
			credentialName: entry.displayName,
			field,
		}
	} catch (err) {
		if (err instanceof ScopeDeniedError) {
			return {
				kind: 'error',
				status: 403,
				message: `You can't use the "${entry.displayName}" login yet. Call request_keychain_access so a person can allow it, then end your turn. Nothing was typed.`,
			}
		}
		if (
			err instanceof CredentialNotFoundError ||
			err instanceof CredentialUndoneError ||
			err instanceof CredentialPendingError ||
			err instanceof CredentialUnavailableError
		) {
			return {
				kind: 'error',
				status: 404,
				message: `The "${entry.displayName}" login is not available any more. Nothing was typed.`,
			}
		}
		throw err
	}
}

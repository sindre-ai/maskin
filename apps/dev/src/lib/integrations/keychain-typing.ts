import type { Database } from '@maskin/db'
import { byoLoginEnvNames } from '@maskin/shared'
import { decodeLogin } from './byo-login'
import { credentialIndex } from './custom-mcp-keychain'
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

	const names = byoLoginEnvNames(name)
	const entry = names ? (await credentialIndex(db, ctx.workspaceId)).get(names[field]) : undefined
	if (!entry || entry.kind !== 'login') {
		return {
			kind: 'error',
			status: 404,
			message: `There is no saved login called "${name}". Call list_keychain_credentials for the exact names, or request_keychain_credential to ask the user to add it. Nothing was typed.`,
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

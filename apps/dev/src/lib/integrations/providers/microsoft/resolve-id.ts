import type { StoredCredentials } from '../../types'
import { GRAPH_BASE, GraphError, graphJson } from './graph'

interface GraphMe {
	mail?: string | null
	userPrincipalName?: string | null
}

/**
 * The connected account's email, as the integration's external id. Stable per
 * account and readable in Settings ("Connected as ..."). `mail` can be empty for
 * accounts without a mailbox, so the sign-in name is the fallback.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (!credentials.accessToken) {
		throw new Error('Cannot resolve Microsoft account: no access token in credentials')
	}
	const me = await graphJson<GraphMe>(
		`${GRAPH_BASE}/me?$select=mail,userPrincipalName`,
		credentials.accessToken,
	).catch((err) => {
		if (err instanceof GraphError) {
			throw new Error(`Failed to resolve Microsoft account: HTTP ${err.status} ${err.code}`)
		}
		throw err
	})
	const id = me.mail || me.userPrincipalName
	if (!id) throw new Error('Microsoft /me response had no mail or userPrincipalName')
	return id.toLowerCase()
}

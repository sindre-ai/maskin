import type { ProviderConfig, StoredCredentials } from '../../types'

export const MICROSOFT_PROVIDER = 'microsoft'

/**
 * Microsoft work or school sign-in, used to land Teams meeting transcripts as
 * meeting objects (poll job in sync.ts). Delegated access only: the person signs
 * in with their own account and Maskin reads what that account can read.
 *
 * `organizations` is the endpoint for work or school accounts from any company
 * (multi-tenant). Personal Microsoft accounts cannot call the transcript API, so
 * the endpoint refuses them at sign-in rather than letting them connect and then
 * find nothing.
 *
 * Scopes, each tied to one call in sync.ts:
 *  - Calendars.ReadWrite: the person's calendar events that carry a Teams link (the poll job only
 *    reads), and create, change and cancel an event (outlook_*_event). It replaces Calendars.Read,
 *    which it covers. The event tools only touch events with nobody else invited.
 *  - Mail.ReadWrite: read and search the mailbox and save drafts (outlook_* mail tools). Graph has no
 *    narrower scope for creating a draft. It would also allow edits and deletes, so the MCP tools
 *    only ever read, and create a draft.
 *  - Mail.Send: send one message after a person approved that exact text (outlook_send_mail). Graph
 *    has no narrower scope for sendMail. It is only used from the approved-send path (send.ts).
 *  - Files.ReadWrite.All: list, search, read and upload files in OneDrive and in SharePoint document
 *    libraries (onedrive_* tools). Files.ReadWrite reaches only the person's own OneDrive, and
 *    Microsoft lists Files.ReadWrite.All or Sites.ReadWrite.All as the next step for SharePoint
 *    libraries; this is the narrower of the two.
 *  - Sites.Read.All: find a SharePoint site by name (sharepoint_search_sites), the only call that
 *    needs it. Sites.ReadWrite.All is not asked for: no tool needs it.
 *  - OnlineMeetings.Read: find the online meeting for an event by its join link
 *    (Graph "get onlineMeeting" with a JoinWebUrl filter lists this as the least
 *    privileged delegated permission). The spec said to add it only if the end to
 *    end check shows it is needed; the docs already say it is, and adding a scope
 *    after people connected means everyone reconnecting.
 *  - OnlineMeetingTranscript.Read.All: list and fetch the transcripts. Microsoft
 *    marks it as needing admin approval in some companies.
 *  - User.Read: the account's email, used as the integration's external id.
 *  - offline_access: a refresh token, so the connection survives past an hour.
 *
 * No webhook: transcripts are pulled by the poll job.
 *
 * MCP is Maskin-hosted, like Deepdots: Outlook calendar, mail and file tools served at
 * `${MASKIN_API_URL}/api/integrations/microsoft/mcp` (./mcp-server.ts). The spec references only
 * MASKIN_API_KEY, so the Microsoft token is never injected into a session; the route resolves it
 * server-side. `autoInject: false` so each agent opts in (or gets it through an access grant).
 * The scopes above are all the tools need.
 */
export const config: ProviderConfig = {
	name: MICROSOFT_PROVIDER,
	displayName: 'Microsoft',
	description:
		'Teams meeting transcripts land in Maskin as meetings. Agents can also read and change your Outlook calendar (only events with nobody else invited), read your Outlook mail, save mail drafts, send an email only after a person approves that exact email, and list, search, read and upload files in OneDrive and SharePoint. Work or school accounts only. Covers Teams meetings on your calendar that had transcription on; instant meetings and channel meetings are not included.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
			scopes: [
				'offline_access',
				'User.Read',
				'Calendars.ReadWrite',
				'Mail.ReadWrite',
				'Mail.Send',
				'Files.ReadWrite.All',
				'Sites.Read.All',
				'OnlineMeetings.Read',
				'OnlineMeetingTranscript.Read.All',
			],
			pkce: true,
			clientIdEnv: 'MICROSOFT_CLIENT_ID',
			clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
		},
	},

	externalIdDisplay: 'email',

	mcp: {
		envKey: 'MICROSOFT_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/microsoft/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}

/**
 * Microsoft answers with the Graph scopes it granted and never lists
 * offline_access, even when it issued a refresh token because of it. Left alone,
 * the scope-drift check would read that as a missing scope and show "Reconnect
 * needed" on every healthy connection. A refresh token only exists when
 * offline_access was granted, so adding it back is accurate.
 */
export function parseTokenResponse(raw: unknown): Partial<StoredCredentials> {
	if (typeof raw !== 'object' || raw === null) return {}
	const body = raw as Record<string, unknown>
	if (typeof body.scope !== 'string' || typeof body.refresh_token !== 'string') return {}
	const granted = body.scope.split(/\s+/).filter(Boolean)
	if (granted.includes('offline_access')) return {}
	return { scope: [...granted, 'offline_access'].join(' ') }
}

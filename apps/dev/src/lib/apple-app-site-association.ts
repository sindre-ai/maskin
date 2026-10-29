// Associated-domains manifest for the native Apple app (bundle io.maskin.app).
// Paths mirror the web routes the app can open; `/invite` carries `?token=`.
const TEAM_ID_RE = /^[A-Z0-9]{10}$/

export function buildAppleAppSiteAssociation(teamId: string | undefined) {
	if (!teamId || !TEAM_ID_RE.test(teamId)) return null
	return {
		applinks: {
			details: [
				{
					appIDs: [`${teamId}.io.maskin.app`],
					components: [
						{ '/': '/invite', '?': { token: '?*' } },
						{ '/': '/*/objects/*' },
						{ '/': '/*/chats/*' },
						{ '/': '/*/notifications' },
					],
				},
			],
		},
	}
}

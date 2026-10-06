/** Copy for the Drive detail page, from the design spec Copy section. Strings
 *  marked EDITED differ from the spec: reconciliation 1 (v1 requests one scope,
 *  so no three-scope wording) and reconciliation 2 (Drive is its own OAuth
 *  client, so no "same grant" wording). */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const DRIVE_COPY = {
	providerCard: {
		pill: 'New',
		description: 'File bytes, Docs, Sheets, search, folder watch, write, comments.',
		meta: 'Free · Piggybacks on Google auth',
	},
	pageTitle: 'Google Drive',
	// EDITED (reconciliations 1 and 2).
	pageDescription:
		'Drive uses the same Google account you already connected. To turn it on for a human, approve Drive access with Google once — one click, no new account.',
	scopeAddMline: (humans: number, withDrive: number, needAdd: number) =>
		`${plural(humans, 'human', 'humans')} on Google · ${withDrive} ${withDrive === 1 ? 'has' : 'have'} Drive · ${needAdd} ${needAdd === 1 ? 'needs' : 'need'} scope add`,
	// Counts of file reads, writes and watches have no stored source; omitted.
	connectedMline: (humans: number) => `${plural(humans, 'human', 'humans')} connected`,
	// No spec line for this variant; the connected line plus the reconnect count.
	needsReconnectMline: (humans: number, needReconnect: number) =>
		`${plural(humans, 'human', 'humans')} connected · ${needReconnect} ${needReconnect === 1 ? 'needs' : 'need'} reconnect`,
	scopeAddBannerTitle: (n: number) =>
		`${plural(n, 'human needs', 'humans need')} to add Drive permissions`,
	// EDITED (reconciliations 1 and 2).
	scopeAddBannerBody: (names: string) =>
		`${names} already ${names.includes(' and ') || names.includes(',') ? 'have' : 'has'} Google connected — one click starts the Drive sign-in for the same Google account, no new account required.`,
	scopeAddBannerCta: 'Grant for all →',
	reconnectBannerTitle: 'Reconnect Google — your token was invalidated',
	reconnectBannerBody: (names: string) =>
		`${names}'s Drive sign-in needs to be run again. Reconnecting uses the same Google account — nothing on the Google side changes.`,
	reconnectBannerCta: 'Reconnect →',
	humanCta: 'Add Drive permissions →',
	humanReconnectCta: 'Reconnect →',
	statusPill: { connected: 'Connected', partial: 'Partial', attention: 'Attention' },
	// EDITED: the spec's drive.file and "declining" sentences describe three scopes.
	calloutLead: 'Who reads what.',
	calloutBody:
		" When an agent needs to read a file, Maskin uses that human's Drive token — Google scopes reads to files the human can already see. Agents cannot see files a human wouldn't.",
	idleHuman: 'No Drive reads yet',
	recentActivityLabel: 'Recent Drive activity',
	// No spec copy for the empty state; written for this task.
	emptyTitle: 'Drive is not connected',
	emptyDescription: 'Connect a Google account to give your agents access to Drive.',
	emptyCta: 'Connect Drive',
	flagOffTitle: 'Google Drive is not available yet',
	flagOffDescription: 'This integration is not turned on for your account.',
} as const

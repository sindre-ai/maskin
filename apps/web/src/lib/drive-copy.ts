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
	// EDITED (conformance pass): the spec's "need scope add" describes a scope-add to a
	// shared grant; Drive is its own sign-in, so the line says "need Drive".
	scopeAddMline: (humans: number, withDrive: number, needAdd: number) =>
		`${plural(humans, 'human', 'humans')} on Google · ${withDrive} ${withDrive === 1 ? 'has' : 'have'} Drive · ${needAdd} ${needAdd === 1 ? 'needs' : 'need'} Drive`,
	// Prototype View 3 line, minus its "All N humans are connected." lead-in (the m-line
	// carries the count). Shown on the connected variant only; the scope-add sentence
	// above is wrong once everyone is connected.
	connectedDescription:
		"Drive-native tools are available to any agent — attach the MCP from the agent's Tools tab. Nothing to configure here beyond who's connected and which folders are watched.",
	// Counts of file reads, writes and watches have no stored source; omitted.
	connectedMline: (humans: number) => `${plural(humans, 'human', 'humans')} connected`,
	// No spec line for this variant; the connected line plus the reconnect count.
	needsReconnectMline: (humans: number, needReconnect: number) =>
		`${plural(humans, 'human', 'humans')} connected · ${needReconnect} ${needReconnect === 1 ? 'needs' : 'need'} reconnect`,
	scopeAddBannerTitle: (n: number) =>
		`${plural(n, 'human needs', 'humans need')} to add Drive permissions`,
	// EDITED (reconciliations 1 and 2, conformance pass): the connect flow signs in
	// whoever clicks, so the banner cannot "grant for all"; each human approves their own.
	scopeAddBannerBody: (names: string) =>
		`${names} already ${names.includes(' and ') || names.includes(',') ? 'have' : 'has'} Google connected. Approve Drive access with Google once per human — same Google account, no new account required.`,
	scopeAddBannerCta: 'Connect Drive →',
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
		' Agents read Drive through one connected account per workspace, the earliest one still active. They can see every file that account can see.',
	foldersLabel: 'Folder watches',
	// No spec copy for these three; written for this task. There is no add-a-watch
	// control (approved call 8), so the empty state says where watches come from.
	foldersEmptyTitle: 'No folders are being watched',
	foldersEmptyDescription:
		"Watches are set up from an agent's trigger settings. Once an agent watches a folder, it shows up here.",
	foldersError: 'Could not load folder watches',
	stopWatch: 'Stop watch',
	stopWatchLabel: (folder: string) => `Stop watch for ${folder}`,
	idleHuman: 'No Drive reads yet',
	recentActivityLabel: 'Recent Drive activity',
	flagOffTitle: 'Google Drive is not available yet',
	flagOffDescription: 'This integration is not turned on for your account.',
} as const

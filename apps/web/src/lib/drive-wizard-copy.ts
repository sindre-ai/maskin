/** Copy for the Drive connect wizard and first-call state, from the design spec
 *  Copy section. Strings marked EDITED differ from the spec: reconciliation 1
 *  (v1 requests one scope, so no three-scope, optional-scope or "6 of 8 JTBDs"
 *  wording) and reconciliation 2 (Drive is its own OAuth client, so no "same
 *  grant" wording). */

export const DRIVE_WIZARD_COPY = {
	title: 'Connect your Google account for Drive',
	body: 'Your Maskin agents will get to read files you can see, write files on your behalf, and watch folders for new drops. You stay in charge of which agents get access.',
	steps: [
		{
			lead: 'Sign in with Google.',
			// EDITED: the spec says the Drive scopes are added to the same grant.
			text: ' One OAuth window. If you already have Gmail, Calendar or Meet connected on Maskin, use the same Google account — no new account.',
		},
		{
			lead: 'Confirm the permissions.',
			// EDITED: the spec lists three capabilities, the third optional.
			text: ' Google will ask you to allow Maskin to edit & comment on any file in your Drive.',
		},
		{
			lead: "You're done.",
			// The google_drive tag renders between text and textAfter. Meeting Analyst,
			// KPI Analyst and Sales Rep are example agents that may not exist in this
			// workspace, so the spec's list is dropped.
			text: ' Attach the ',
			textAfter: " MCP to any agent that needs Drive tools from the agent's Tools tab.",
		},
	],
	scopesTitle: 'Permissions this adds to your Google account:',
	cancel: 'Cancel',
	continue: 'Continue with Google →',
	loading: 'Opening Google…',
	error: 'Sign-in was cancelled. Try again when ready.',
} as const

/** Wizard description per requested scope, keyed by scope URL. A scope added to
 *  DRIVE_SCOPES later needs one entry here. EDITED: the spec's three rows
 *  (drive.readonly, drive.file, drive) collapse into the one scope v1 requests,
 *  without its "(optional)" tag or the decline sentence. */
export const DRIVE_WIZARD_SCOPE_DESCRIPTIONS: Record<string, string> = {
	'https://www.googleapis.com/auth/drive':
		' — powers file bytes, Docs, Sheets, search, folder walk, folder watch, writes and Doc comments.',
}

export const DRIVE_FIRST_CALL_COPY = {
	headline: 'Drive is connected. Point your agents at a file.',
	bodyBefore:
		'Your agents get the eight tools below the moment they need to read, write or watch a file. Nothing to configure — attach the ',
	bodyAfter: ' MCP to any agent that touches artifacts.',
	cardsLabel: 'What your agents can now do',
	sampleLabel: "Sample notification (what you'll see when it fires)",
	sample: {
		agent: 'Meet Watcher',
		action: 'fired on new file',
		tool: 'watch_folder',
		time: 'just now',
		message:
			'New recording landed in /Meet Recordings — "Acme × Beta demo (2026-09-10).mp4" (128 MB). Handed off to Meeting Analyst for recap.',
		primary: 'Open file',
		secondary: 'See workflow',
	},
	// Titles verbatim from the spec. Descriptions are from the prototype; its
	// per-card example agent names (meeting_analyst, kpi_analyst, ...) are dropped
	// because they are not agents in this workspace.
	jtbds: [
		{
			glyph: '▤',
			title: 'Read file bytes',
			description:
				'Any file by ID — PDFs, videos, images, docx. Enables Meet recording playback + arbitrary artifact review.',
		},
		{
			glyph: '✎',
			title: 'Read structured Docs',
			description:
				'Headings, paragraphs, tables. Meet transcript Docs, spec files, customer briefs — all readable without copy-paste.',
		},
		{
			glyph: '◈',
			title: 'Read Sheet ranges',
			description:
				'Pull A1:F32 or a named range from any Sheet — KPI dashboards, pipelines, budgets — unattended.',
		},
		{
			glyph: '⌕',
			title: 'Search Drive',
			description:
				'Full-text + metadata search across everything the human can see. Find "the deck from Acme" without knowing the file ID.',
		},
		{
			glyph: '▦',
			title: 'Walk folder trees',
			description:
				'List folder contents, recurse, filter by MIME type. Ingest a whole customer-brief folder at once.',
		},
		{
			glyph: '◐',
			title: 'Watch a folder',
			description:
				'Fire when a new file lands — Meet recording arrival, customer brief drop, deck upload. Highest-leverage trigger.',
		},
		{
			glyph: '✚',
			title: 'Write files',
			description:
				"Create Docs, upload files. Deliver summaries, drafts, reports directly into a human's Drive.",
		},
		{
			glyph: '◆',
			title: 'Comment on a Doc',
			description:
				'Inline comments & suggestions on a Doc — a reviewer agent can leave feedback the way a human would.',
		},
	],
} as const

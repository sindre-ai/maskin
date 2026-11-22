// Canonical source-item IDs and metadata for the Accounting marketplace flow (install slug
// accounting-loop). The bundle is a single agent, the Bookkeeper. Trigger and skill IDs are not
// listed as constants: they are derived per actor via `triggerIdsForActor` / `skillIdsForActor`
// in apps/dev/src/lib/marketplace-loops/loop-data.

export const ACCOUNTING_LOOP_ACTOR_BOOKKEEPER = '2efeee74-29d6-4ef6-854a-e8c05cecfe9b'

export const ACCOUNTING_LOOP_SLUG = 'accounting-loop'
export const ACCOUNTING_LOOP_NAME = 'Accounting'
export const ACCOUNTING_LOOP_VERSION = '1.0.0'
export const ACCOUNTING_LOOP_USE_CASE = 'Finance'
export const ACCOUNTING_LOOP_DESCRIPTION =
	"Turns receipts into draft vouchers in your accounting system, and lists what looks wrong for your adviser. You upload a photo or PDF of a receipt in the flow's chat. The Bookkeeper reads it, saves it as a draft voucher and flags any doubt, such as a missing receipt, VAT that does not add up, a double payment or a private cost. It never books, changes or deletes anything: a person approves every draft in your accounting system. At install you pick your accounting system from a list, and each system shows whether it is ready, needs setup or is not available yet. You then connect it once, and the flow checks the connection and tells you what to fix. A weekly check catches a connection that stopped working."

// The accounting systems an owner can pick from, and how far each one connects. This list is the one
// place the status of a system is kept: the accounting-systems skill the Bookkeeper reads is built
// from it (apps/dev/src/lib/marketplace-loops/accounting-systems.ts). A connector task changes its
// own line here when it is done.
//
// ready: the connector passed its test on a test company.
// needs_setup: the owner must do a step in their own system first (keys, token, admin approval),
//   and `note` says what.
// not_yet: nothing connects yet.
export const ACCOUNTING_SYSTEM_STATUSES = ['ready', 'needs_setup', 'not_yet'] as const
export type AccountingSystemStatus = (typeof ACCOUNTING_SYSTEM_STATUSES)[number]

export interface AccountingSystem {
	name: string
	status: AccountingSystemStatus
	note: string
}

export const ACCOUNTING_SYSTEMS: readonly AccountingSystem[] = [
	{
		name: 'Dinero',
		status: 'needs_setup',
		note: 'Needs a Pro or Total plan. Create an integration in Dinero and save its client ID, client secret and API key once under Integrations, in the Connect Dinero form. The steps are in the accounting-connection-check skill.',
	},
	{ name: 'Numina', status: 'not_yet', note: 'The connection is not built yet.' },
	{ name: 'Uniconta', status: 'not_yet', note: 'The connection is not built yet.' },
	{ name: 'Odoo', status: 'not_yet', note: 'The connection is not built yet.' },
	{ name: 'Business Central', status: 'not_yet', note: 'The connection is not built yet.' },
	{ name: 'e-conomic', status: 'not_yet', note: 'The connection is not built yet.' },
	{ name: 'Billy', status: 'not_yet', note: 'The connection is not built yet.' },
	{
		name: 'Zenegy',
		status: 'not_yet',
		note: 'Not available until its connection has passed a test.',
	},
	{ name: 'Appelsin', status: 'not_yet', note: 'Appelsin has no way to connect.' },
]

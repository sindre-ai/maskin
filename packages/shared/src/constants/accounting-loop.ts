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
	"Turns receipts into draft vouchers in your accounting system, and lists what looks wrong for your adviser. You upload a photo or PDF of a receipt in the flow's chat. The Bookkeeper reads it, saves it as a draft voucher in Dinero and flags any doubt, such as a missing receipt, VAT that does not add up, a double payment or a private cost. It never books, changes or deletes anything: a person approves every draft in Dinero. After install you add Dinero's own server as a tool and sign in. The flow checks the connection and tells you what to fix. Dinero's sign-in runs out after about an hour and cannot be renewed by the flow, so a person signs in again when it does. A weekly check tells you when that has happened."

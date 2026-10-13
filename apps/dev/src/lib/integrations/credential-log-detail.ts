import type { CredentialTier } from '@maskin/db/schema'

// The one place that builds the text stored in credential_access_log.detail.
// The column is hashed as stored, so this function owns the format: four keys,
// always all four, always in this order, an empty value for an absent key:
//
//   approver=<uuid>;grant=<uuid>;tier=<1|2|3>;ext=<uuid>
//
// Every value is a uuid or one digit, so nothing needs escaping, and the 512
// character CHECK and the chr(31) ban on the column can never trip.
//
// Call it only from the getCredential and grant code path (and the tier-marking
// route, which writes tier only). Never feed it request text: the reason string
// and the session id of an access request must not reach it. The parameter types
// are uuid-shaped on purpose, and the writer refuses anything else, so a free
// text value cannot get in even by mistake.

export interface CredentialLogDetailInput {
	approver?: string | null
	grant?: string | null
	tier?: CredentialTier | null
	ext?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidOrEmpty(key: string, value: string | null | undefined): string {
	if (value === undefined || value === null) return ''
	if (!UUID.test(value)) throw new Error(`credential log detail: ${key} must be a uuid`)
	return value.toLowerCase()
}

export function formatCredentialLogDetail(input: CredentialLogDetailInput): string {
	const tier = input.tier ?? null
	if (tier !== null && tier !== 1 && tier !== 2 && tier !== 3) {
		throw new Error('credential log detail: tier must be 1, 2 or 3')
	}
	return [
		`approver=${uuidOrEmpty('approver', input.approver)}`,
		`grant=${uuidOrEmpty('grant', input.grant)}`,
		`tier=${tier ?? ''}`,
		`ext=${uuidOrEmpty('ext', input.ext)}`,
	].join(';')
}

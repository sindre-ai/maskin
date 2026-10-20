import { CredentialUndoneError } from './errors'

/**
 * integrations.credentials is NULL only on an undone row (migration 0088: Keychain
 * undo zeroises it and keeps the row for the audit chain). Code that reads the
 * column directly goes through here so a NULL surfaces as a typed error instead of
 * decrypt(null) throwing something unrelated.
 */
export function requireCredentials(row: { id?: string; credentials: string | null }): string {
	if (row.credentials === null) throw new CredentialUndoneError(row.id ?? 'unknown')
	return row.credentials
}

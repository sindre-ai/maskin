/** Longest key value the Keychain accepts. */
export const CREDENTIAL_VALUE_MAX_LENGTH = 1024

export type CredentialValueProblem =
	| 'length'
	| 'edge_whitespace'
	| 'control_character'
	| 'non_ascii'
	| 'double_quote'
	| 'backslash'

const MESSAGES: Record<CredentialValueProblem, string> = {
	length: `The key must be 1 to ${CREDENTIAL_VALUE_MAX_LENGTH} characters long.`,
	edge_whitespace: 'The key must not start or end with whitespace, including a line break.',
	control_character: 'The key must not contain a control character.',
	non_ascii: 'The key may only use printable ASCII characters.',
	double_quote: 'The key must not contain a double quote.',
	backslash: 'The key must not contain a backslash.',
}

export class CredentialValueError extends Error {
	readonly status = 400
	readonly code = 'BAD_REQUEST'
	constructor(readonly problem: CredentialValueProblem) {
		super(MESSAGES[problem])
		this.name = 'CredentialValueError'
	}
}

/**
 * The first rule a key value breaks, or null. The container expands a reference to
 * the key into the tool config file as raw text (envsubst), so a quote, a backslash
 * or a line break in the value would break the JSON for the whole agent on its next
 * launch. Checked in the order a person would fix them, and the result names the
 * rule only: the value is never part of it.
 */
export function checkCredentialValue(value: string): CredentialValueProblem | null {
	if (value.length < 1 || value.length > CREDENTIAL_VALUE_MAX_LENGTH) return 'length'
	if (/^\s|\s$/.test(value)) return 'edge_whitespace'
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return 'control_character'
	}
	if (/[^ -~]/.test(value)) return 'non_ascii'
	if (value.includes('"')) return 'double_quote'
	if (value.includes('\\')) return 'backslash'
	return null
}

/** The value rule every bring-your-own API key goes through, from the paste form and from chat. */
export function assertValidCredentialValue(value: string): void {
	const problem = checkCredentialValue(value)
	if (problem !== null) throw new CredentialValueError(problem)
}

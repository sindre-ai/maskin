/** Longest username, email and password the Keychain accepts for a login. */
export const LOGIN_USERNAME_MAX_LENGTH = 256
export const LOGIN_EMAIL_MAX_LENGTH = 256
export const LOGIN_PASSWORD_MAX_LENGTH = 1024

export type LoginValueProblem =
	| 'username_length'
	| 'username_edge_whitespace'
	| 'username_control_character'
	| 'email_length'
	| 'email_edge_whitespace'
	| 'email_control_character'
	| 'password_length'
	| 'password_control_character'

const MESSAGES: Record<LoginValueProblem, string> = {
	username_length: `The username must be 1 to ${LOGIN_USERNAME_MAX_LENGTH} characters long.`,
	username_edge_whitespace:
		'The username must not start or end with whitespace, including a line break.',
	username_control_character: 'The username must not contain a control character.',
	email_length: `The email must be 1 to ${LOGIN_EMAIL_MAX_LENGTH} characters long.`,
	email_edge_whitespace: 'The email must not start or end with whitespace, including a line break.',
	email_control_character: 'The email must not contain a control character.',
	password_length: `The password must be 1 to ${LOGIN_PASSWORD_MAX_LENGTH} characters long.`,
	password_control_character:
		'The password must not contain a control character, including a line break.',
}

export class LoginValueError extends Error {
	readonly status = 400
	readonly code = 'BAD_REQUEST'
	constructor(readonly problem: LoginValueProblem) {
		super(MESSAGES[problem])
		this.name = 'LoginValueError'
	}
}

function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

/**
 * The first rule a login breaks, or null. Looser than the API-key rule on purpose: a
 * password is typed by a person and routinely holds quotes, backslashes and non-ASCII
 * characters, which the key rule refuses because a key is substituted into JSON tool
 * config. A login is only ever injected as its own env vars, never referenced from
 * tool config, so those characters are safe here. A line break is still refused: it is
 * almost always a stray paste, and it would split the value in a shell. The message
 * names the rule only, never the value.
 */
export function checkLoginFields(
	username: string,
	password: string,
	email?: string,
): LoginValueProblem | null {
	if (username.length < 1 || username.length > LOGIN_USERNAME_MAX_LENGTH) return 'username_length'
	if (/^\s|\s$/.test(username)) return 'username_edge_whitespace'
	if (hasControlCharacter(username)) return 'username_control_character'
	if (password.length < 1 || password.length > LOGIN_PASSWORD_MAX_LENGTH) return 'password_length'
	if (hasControlCharacter(password)) return 'password_control_character'
	// Optional, for a site that asks for a username and an email. Held to the username rules.
	if (email !== undefined) {
		if (email.length < 1 || email.length > LOGIN_EMAIL_MAX_LENGTH) return 'email_length'
		if (/^\s|\s$/.test(email)) return 'email_edge_whitespace'
		if (hasControlCharacter(email)) return 'email_control_character'
	}
	return null
}

export function assertValidLoginFields(username: string, password: string, email?: string): void {
	const problem = checkLoginFields(username, password, email)
	if (problem !== null) throw new LoginValueError(problem)
}

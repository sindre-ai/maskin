/**
 * What an agent may do when it sends something in a person's or the company's name.
 *
 * Each draft kind an agent can send has one of three settings, per agent, with a workspace
 * default for anything not set (a more specific setting beats the default):
 *
 *   always_allow  the agent sends without asking; the send is logged on the draft (`auto_sent`)
 *   ask_first     nothing goes out until a person approves the exact text of a draft (on its
 *                 card, after editing it there, or by saying yes in the chat)
 *   deny          the send tool refuses, whatever the agent says
 *
 * Only a human admin or owner can change a setting. Resolution and the send gate live in
 * apps/dev/src/lib/send-permissions.ts.
 */
export const SEND_PERMISSION_MODES = ['always_allow', 'ask_first', 'deny'] as const
export type SendPermissionMode = (typeof SEND_PERMISSION_MODES)[number]

export const SEND_PERMISSION_MODE_LABELS: Record<SendPermissionMode, string> = {
	always_allow: 'Always allow',
	ask_first: 'Ask first',
	deny: 'Deny',
}

/**
 * The draft kinds that have a send tool, which is what a setting is keyed on. A kind an
 * integration adds later is missing from here until it is added, and a send of a kind that is
 * not listed is treated as ask_first. A test keeps this list in step with the integrations.
 */
export const SEND_PERMISSION_KINDS = [
	'email',
	'linkedin_message',
	'linkedin_connection_request',
	'linkedin_inmail',
	'linkedin_post',
	'linkedin_comment',
	'linkedin_comment_reply',
	'linkedin_post_edit',
	'slack_message',
	'manual_message',
] as const
export type SendPermissionKind = (typeof SEND_PERMISSION_KINDS)[number]

export const SEND_PERMISSION_KIND_LABELS: Record<SendPermissionKind, string> = {
	email: 'Email',
	linkedin_message: 'LinkedIn message',
	linkedin_connection_request: 'LinkedIn connection request',
	linkedin_inmail: 'LinkedIn InMail',
	linkedin_post: 'LinkedIn post',
	linkedin_comment: 'LinkedIn comment',
	linkedin_comment_reply: 'LinkedIn comment reply',
	linkedin_post_edit: 'LinkedIn post edit',
	slack_message: 'Slack message',
	manual_message: 'Message sent by hand',
}

/**
 * Where a workspace starts: every kind sends directly (Sebastian, 11 Nov 2026: an agent with
 * Read & write sends; a person turns a kind to ask first, or off, per agent or for the whole
 * workspace). This is the answer for a workspace that has no saved row. It replaces the 4 Nov
 * start (ask first for email, LinkedIn messages, invitations and InMail); the rows that
 * migration wrote into existing workspaces are saved settings and stay as they are until a
 * person changes them.
 */
export const STARTING_SEND_MODES: Record<SendPermissionKind, SendPermissionMode> = {
	email: 'always_allow',
	linkedin_message: 'always_allow',
	linkedin_connection_request: 'always_allow',
	linkedin_inmail: 'always_allow',
	linkedin_post: 'always_allow',
	linkedin_comment: 'always_allow',
	linkedin_comment_reply: 'always_allow',
	linkedin_post_edit: 'always_allow',
	slack_message: 'always_allow',
	manual_message: 'always_allow',
}

export const isSendPermissionKind = (value: string): value is SendPermissionKind =>
	(SEND_PERMISSION_KINDS as readonly string[]).includes(value)

export const isSendPermissionMode = (value: string): value is SendPermissionMode =>
	(SEND_PERMISSION_MODES as readonly string[]).includes(value)

// Host switch for the readable workspace prompt (bet "Agents start with a smaller context",
// task C). Unset (the default), "0" or "false": sessions start exactly as they did before.
// When on, three things change together: the agent server keeps newlines, tabs and non-ASCII
// text in env values (it used to strip them, which flattened the system prompt to one line),
// the chat "What you drive" block no longer repeats each flow's targets, and the
// ask_user_question instruction is written once. Set it on the apps/dev service and restart;
// rollback is unsetting it. It rides to the agent server as an env var of the session.
export const READABLE_PROMPT_ENV = 'MASKIN_READABLE_PROMPT'

export function isReadablePromptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !['', '0', 'false', 'off'].includes((env[READABLE_PROMPT_ENV] ?? '').trim().toLowerCase())
}

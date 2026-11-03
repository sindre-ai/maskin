/**
 * §7.8 / §18 — chat-resume UX behaviour flag.
 *
 * Awaits Magnus's go/no-go on the "interim message vs silence-then-resume"
 * question. Default is the interim message (Strategist's recommendation).
 * Flip this constant to `false` if Magnus picks silence; scheduler + parser
 * stay unchanged in either case.
 */
export const CHAT_RESUME_INTERIM_MESSAGE_ENABLED = true

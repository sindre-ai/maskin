// Git committer identity for agent sessions. Agents commit from inside their
// sandbox, and nothing in docker/agent-base sets user.name/user.email on its
// own, so before this every session improvised an address at commit time —
// which is how ~40 fabricated identities (agent@maskin.ai, dev@maskin.ai,
// developer@maskin.local, ...) ended up in the history. Anything at a domain we
// do not own is claimable: verifying such an address on a GitHub account
// retroactively credits its holder as a contributor. maskin.ai in particular is
// registered to someone else, and one stray co-author trailer is all it took to
// put a stranger on this repo's contributor list.
//
// docker/agent-base/agent-run.sh reads GIT_IDENTITY_NAME / GIT_IDENTITY_EMAIL
// and falls back to `Maskin Agent <agent@maskin.io>` when they are unset; this
// module supplies the per-agent values the session manager injects.

// Every agent commits under the bot's GitHub noreply address rather than a
// maskin.io mailbox. Addresses in the users.noreply.github.com namespace are
// reserved by GitHub and can never be verified by anyone else, so unlike a
// domain-based identity this cannot become claimable if a domain lapses — the
// exact failure that put a stranger on the contributor list to begin with.
// Per-agent granularity lives in the NAME instead, which is enough: `git log
// --author=` matches a regex against the whole `Name <email>` ident.
export const AGENT_GIT_IDENTITY_EMAIL = '269919880+sindre-maskin[bot]@users.noreply.github.com'

// Used when an agent's name sanitizes down to nothing. Matches the fallback
// baked into agent-run.sh so both paths agree.
export const AGENT_GIT_IDENTITY_FALLBACK_NAME = 'Maskin Agent'

// Marks the commit as machine-authored in `git log` and blame without the
// reader needing to know the agent roster.
const AGENT_NAME_SUFFIX = ' (Maskin agent)'

// Git idents cannot contain '<', '>', or a newline — those terminate the ident
// grammar, so a name carrying one produces a commit git either rejects or
// records wrong. actors.name is user-supplied free text, which means a
// workspace admin could otherwise break every commit their agent makes just by
// naming it oddly. Cap chosen to keep the rendered ident comfortably inside the
// ~78 chars git's own tooling wraps at, suffix included.
const MAX_NAME_LENGTH = 64

/**
 * Reduce an agent's display name to something safe to put in a git ident.
 * Strips the ident-breaking characters and all control characters, collapses
 * whitespace, trims, and truncates. Returns '' when nothing usable is left —
 * callers substitute AGENT_GIT_IDENTITY_FALLBACK_NAME.
 */
export function sanitizeGitIdentName(raw: string | null | undefined): string {
	if (!raw) return ''
	return (
		raw
			// \p{Cc} is every Unicode control character, C1 range included.
			.replace(/[<>\p{Cc}]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, MAX_NAME_LENGTH)
			.trim()
	)
}

export interface AgentGitIdentity {
	name: string
	email: string
}

/**
 * Build the GIT_IDENTITY_NAME / GIT_IDENTITY_EMAIL pair for one agent. The
 * email is deliberately the same for every agent (see AGENT_GIT_IDENTITY_EMAIL);
 * the name carries the granularity.
 */
export function buildAgentGitIdentity(agentName: string | null | undefined): AgentGitIdentity {
	const base = sanitizeGitIdentName(agentName) || AGENT_GIT_IDENTITY_FALLBACK_NAME
	const name = base.endsWith(AGENT_NAME_SUFFIX) ? base : `${base}${AGENT_NAME_SUFFIX}`
	return { name, email: AGENT_GIT_IDENTITY_EMAIL }
}

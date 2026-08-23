#!/usr/bin/env node
// Resolve "the Nth user turn of CLI session <id>" into that turn's transcript
// uuid, which is what `claude --resume-session-at` / `--resume-drops-turn`
// take.
//
// Called by agent-run.sh when apps/dev has asked for a rewind. apps/dev knows
// the ordinal (it counted the turn envelopes it delivered — see
// apps/dev/src/services/conversation-rewind.ts) but cannot see the transcript,
// which lives on the sandbox filesystem. This bridges the two.
//
// Reads the transcript through the Agent SDK's getSessionMessages rather than
// parsing the JSONL directly: the on-disk format is explicitly internal and
// changes between Claude Code releases, so hand-parsing it would rot silently.
//
// Usage:   node resolve-resume-turn.mjs <cli-session-id> <1-based-ordinal> [dir]
// Success: prints the uuid to stdout, exit 0
// Failure: prints a reason to stderr, exit 1 — the caller then starts cold.

// `dir` must be the cwd the CLI session ran in — the transcript path embeds a
// slug derived from it, so looking in the wrong directory finds nothing.
const [sessionId, ordinalRaw, dirArg] = process.argv.slice(2)
const dir = dirArg || '/agent/workspace'

if (!sessionId || !ordinalRaw) {
	console.error('usage: resolve-resume-turn.mjs <cli-session-id> <ordinal>')
	process.exit(1)
}

const ordinal = Number(ordinalRaw)
if (!Number.isInteger(ordinal) || ordinal < 1) {
	console.error(`invalid ordinal: ${ordinalRaw}`)
	process.exit(1)
}

let getSessionMessages
try {
	;({ getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk'))
} catch (err) {
	console.error(`claude-agent-sdk unavailable: ${err?.message ?? err}`)
	process.exit(1)
}

if (typeof getSessionMessages !== 'function') {
	console.error('claude-agent-sdk has no getSessionMessages export')
	process.exit(1)
}

let messages
try {
	messages = await getSessionMessages(sessionId, { dir })
} catch (err) {
	console.error(`could not read transcript for ${sessionId}: ${err?.message ?? err}`)
	process.exit(1)
}

// Only the user turns are counted, matching how apps/dev derived the ordinal:
// one entry per envelope written to the CLI's stdin, seed turn included.
//
// `role === 'user'` alone is NOT that set. The CLI files a tool's output under
// the user role too, so a transcript's user-role entries are overwhelmingly
// tool results — measured 113 tool results to 1 real turn on a representative
// agentic session. Counting those shifts every ordinal and resolves to a uuid
// in the middle of the agent's own work, which is worse than failing: a uuid
// IS found, so the cold-start fallback never fires and the rewind silently
// lands in the wrong place.
//
// A real turn is one apps/dev wrote to stdin: content is either a plain string
// or a block array carrying no tool_result. Subagent entries (parent_tool_use_id
// set) are excluded too — apps/dev only ever delivers main-session turns.
function isDeliveredUserTurn(m) {
	const role = m?.type ?? m?.message?.role
	if (role !== 'user') return false
	if (m?.parent_tool_use_id) return false
	const content = m?.message?.content
	if (Array.isArray(content)) return !content.some((block) => block?.type === 'tool_result')
	return true
}

const userTurns = (messages ?? []).filter(isDeliveredUserTurn)

const turn = userTurns[ordinal - 1]
const uuid = turn?.uuid ?? turn?.id
if (!uuid) {
	console.error(
		`turn ${ordinal} not found (transcript has ${userTurns.length} user turn(s)) for ${sessionId}`,
	)
	process.exit(1)
}

// Belt and braces: never hand back a tool result even if the shapes above drift
// in a future CLI release. Exiting here takes the documented cold-start path,
// which is lossy but correct — resuming at a tool result is neither.
if (!isDeliveredUserTurn(turn)) {
	console.error(`turn ${ordinal} resolved to a non-user entry for ${sessionId}`)
	process.exit(1)
}

process.stdout.write(String(uuid))

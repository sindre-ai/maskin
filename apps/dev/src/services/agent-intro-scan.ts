import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { suggestedStepSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { IntroStep } from './agent-intro-template'
import { startSession } from './session-lifecycle'
import type { SessionManager } from './session-manager'

/** How long the person waits for the agent to look around before the generic steps go out. */
export const INTRO_SCAN_TIMEOUT_MS = 60_000
/** The scan offers at most this many steps; the template adds its own closing step. */
const MAX_SCANNED_STEPS = 3
const MAX_SCANNED_INTEGRATIONS = 4

export type IntroScan = {
	steps: IntroStep[]
	/** Provider names the scan found the job to depend on. Filtered to the catalog by the caller. */
	neededIntegrations: string[]
}

export type IntroScanArgs = {
	workspaceId: string
	agent: { id: string; name: string; description: string | null }
	recipient: { id: string; name: string }
}

/** Resolves to null whenever there is nothing usable: the caller then falls back to generic steps. */
export type IntroScanRunner = (args: IntroScanArgs) => Promise<IntroScan | null>

export function buildIntroScanPrompt(args: IntroScanArgs): string {
	const recipient = args.recipient.name.trim() || 'the person who created you'
	const description = args.agent.description?.trim()
	return [
		`You were just created in this workspace as "${args.agent.name}"${description ? ` (${description})` : ''}, for ${recipient}. They are about to read your first message in a chat with you.`,
		'',
		'Before they see suggestions, take a quick look around so the suggestions fit this workspace. Be fast: at most 6 tool calls, read-only, and finish in under a minute. Do not write, send or change anything.',
		'1. list_integrations: which tools are connected and active.',
		'2. list_keychain_credentials: which credentials exist. Look at names only.',
		'3. list_objects (and list_loops if useful): what is going on right now, such as open bets and tasks.',
		'',
		'Then reply with ONLY a JSON object, no other text and no code fence:',
		'{"steps":[{"label":"...","prompt":"...","action":"send"|"fill"}],"needed_integrations":["linear"]}',
		'',
		'Rules for steps:',
		`- 2 to ${MAX_SCANNED_STEPS} steps, each something ${recipient} could say to you that fits your job AND what you found (a connected tool you can use, or work that is already in the workspace). Name the real tool or item when you can.`,
		'- label: max 60 characters, plain text, no line breaks.',
		'- action "send" is for a step that only reads and reports. A tap sends the prompt as written, so prompt must be identical to label.',
		'- action "fill" is for a step that needs words only the person can supply, or that writes, sends, spends or deletes. prompt is max 200 characters and may end in a space.',
		'- If the workspace has nothing relevant yet, write steps that start from your job alone. Never invent tools or work you did not see.',
		'needed_integrations: provider names (for example "linear", "gmail", "slack", "github") of tools your job needs. Include ones that are NOT connected yet, so the person can add them. Use [] if none.',
	].join('\n')
}

/**
 * Reads the scan's reply. The model is asked for bare JSON but may fence it or add a
 * sentence, so the first object in the text is taken. Steps that break the step rules are
 * dropped one by one (a send step is repaired to prompt = label first); nothing usable is
 * null, which sends the caller to the generic steps.
 */
export function parseIntroScanResult(text: string | null | undefined): IntroScan | null {
	if (!text) return null
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end <= start) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(text.slice(start, end + 1))
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const { steps: rawSteps, needed_integrations: rawIntegrations } = parsed as {
		steps?: unknown
		needed_integrations?: unknown
	}
	if (!Array.isArray(rawSteps)) return null

	const steps: IntroStep[] = []
	for (const raw of rawSteps) {
		if (steps.length === MAX_SCANNED_STEPS) break
		const candidate =
			raw && typeof raw === 'object' && (raw as { action?: unknown }).action === 'send'
				? { ...raw, prompt: (raw as { label?: unknown }).label }
				: raw
		const step = suggestedStepSchema.safeParse(candidate)
		if (step.success) steps.push(step.data)
	}
	if (steps.length === 0) return null

	const neededIntegrations = Array.isArray(rawIntegrations)
		? rawIntegrations
				.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
				.slice(0, MAX_SCANNED_INTEGRATIONS)
		: []
	return { steps, neededIntegrations }
}

/**
 * The real scan: one short background session as the new agent, run to the end, whose
 * result text is the JSON above. Any failure (no credentials, billing cap, a failed or
 * slow session, unreadable output) is a null, never a throw.
 */
export function createIntroScanRunner(deps: {
	db: Database
	sessionManager: SessionManager
}): IntroScanRunner {
	return async (args) => {
		try {
			const handle = await startSession({
				workspaceId: args.workspaceId,
				actorId: args.agent.id,
				callerKind: 'internal',
				actionPrompt: buildIntroScanPrompt(args),
				createdBy: args.recipient.id,
				initiatedFromObjectId: null,
				await: 'terminal',
				awaitTimeoutMs: INTRO_SCAN_TIMEOUT_MS,
			})
			const outcome = await handle.awaitResult
			if (outcome?.kind === 'timed-out') {
				// The wait is over; the session would keep spending, so end it.
				await deps.sessionManager.stopSession(handle.sessionId).catch((err: unknown) =>
					logger.warn('Agent intro scan: could not stop a timed-out session', {
						sessionId: handle.sessionId,
						err,
					}),
				)
				return null
			}
			if (outcome?.kind !== 'settled' || outcome.settle.status !== 'completed') return null

			const [row] = await deps.db
				.select({ result: sessions.result })
				.from(sessions)
				.where(eq(sessions.id, handle.sessionId))
				.limit(1)
			const summary = (row?.result as { summary?: unknown } | null)?.summary
			return parseIntroScanResult(typeof summary === 'string' ? summary : null)
		} catch (err) {
			logger.warn('Agent intro scan fell back to generic steps', { agentId: args.agent.id, err })
			return null
		}
	}
}

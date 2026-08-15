/**
 * Session-scoped classifier for GitHub MCP tool failures observed in the
 * agent runtime's stream-json log output.
 *
 * Why this lives at log ingest and not at the tool-call boundary: production
 * github tool calls are made by Claude Code's own MCP client inside the
 * microsandbox VM, spawned from the `autoInjectedMcpServers` config that
 * `session-manager.ts` writes for each `github-<owner>` MCP entry. Nothing
 * in this codebase intercepts those calls in-process — the only surface we
 * see is the stdout stream that the CLI emits, chunked into log lines that
 * flow through `streamContainerLogs` (local Docker path) and
 * `appendRemoteSessionLogs` (remote microsandbox path). Classifying at that
 * seam is what actually satisfies the parent bet's AC-6 grep-verifier
 * ("grep the last 100 failures, find a cause tag on every one"): every
 * failure a real agent session emits passes through one of those two funnels.
 *
 * The classifier itself (`classifyGithubError` in `error-tagger.ts`) is
 * unchanged — this module is a plumbing shim that (1) parses each stream-json
 * line, (2) correlates `tool_use` → `tool_result` by `tool_use_id`, and
 * (3) hands the failure body to the classifier along with the session's
 * stamped `TokenMetadata` and an installation-ID resolve probe so
 * `token-expired-mid-session` can be told apart from a plain `401-unauth`.
 */

import { logger } from '../../../logger'
import { fetchInstallationOwnerLogin } from './auth'
import { type ClassifiedError, classifyGithubError } from './error-tagger'
import type { TokenMetadata } from './token-metadata'

/**
 * A github installation attached to a session. The `ownerLoginLower` is the
 * key we use to look up the install from a tool name of the form
 * `mcp__github-<owner-lowercase>__<tool>` (matching the `github-<owner>` MCP
 * server names `session-manager.ts` writes into the container config).
 */
export interface SessionGithubInstall {
	ownerLoginLower: string
	installationId: string
	tokenMetadata: TokenMetadata
}

interface SessionState {
	installsByOwner: Map<string, SessionGithubInstall>
	/** Maps stream-json `tool_use.id` → tool name so we can look the name up
	 * when the matching `tool_result` arrives. Kept small (~1 entry per
	 * outstanding tool call) and evicted on `tool_result`. */
	pendingToolUses: Map<string, string>
	/** Cap on `pendingToolUses` size — a runaway agent that emits tool_use
	 * without matching tool_result must not grow this map unboundedly. */
}

const MAX_PENDING_TOOL_USES = 512

/** Prefix of MCP tool names we classify — matches the `github-<owner>` entries
 * in `autoInjectedMcpServers`. Non-github MCPs (Slack, Linear, integration-*)
 * are ignored. */
const GITHUB_MCP_TOOL_PREFIX = 'mcp__github-'

export type ResolveInstallationProbe = (installationId: string) => Promise<boolean>

/**
 * Boolean adapter around `fetchInstallationOwnerLogin`. Returns `true` when
 * the installation still resolves against the App JWT, `false` on a 404
 * (App uninstalled or installation id rotated), and rethrows on any other
 * error so the classifier does not silently interpret a network failure as
 * install-ID rotation. Lives in this module so the log-ingest classifier
 * (the only production consumer) does not depend on the MCP bridge.
 */
export async function resolveInstallationExists(installationId: string): Promise<boolean> {
	try {
		await fetchInstallationOwnerLogin(installationId)
		return true
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (/Failed to fetch installation owner: 404\b/.test(msg)) {
			return false
		}
		throw err
	}
}

/**
 * The result of processing a single log line. `taggedLine`, when set, is a
 * one-line `[system]`-stream annotation the caller should persist alongside
 * the original log line so a grep for `cause_tag=` finds every classified
 * failure. `classified` carries the parsed detail for tests + observability.
 */
export interface LineClassification {
	taggedLine: string
	classified: ClassifiedError
	tool: string
}

export class SessionGithubLogClassifier {
	private readonly sessions = new Map<string, SessionState>()

	constructor(
		private readonly resolveInstallation: ResolveInstallationProbe = resolveInstallationExists,
	) {}

	/**
	 * Register the github installations attached to a session. Called once per
	 * session by `session-manager.ts` right after `resolvedGithubInstalls[]`
	 * is populated. Sessions without any github install are not registered —
	 * classify calls for those sessions no-op immediately.
	 */
	registerSession(sessionId: string, installs: readonly SessionGithubInstall[]): void {
		if (installs.length === 0) return
		const installsByOwner = new Map<string, SessionGithubInstall>()
		for (const install of installs) {
			installsByOwner.set(install.ownerLoginLower, install)
		}
		this.sessions.set(sessionId, {
			installsByOwner,
			pendingToolUses: new Map(),
		})
	}

	/**
	 * Drop all state for a session. Called on completion / stop / timeout so
	 * long-running processes don't accumulate state for finished sessions.
	 */
	unregisterSession(sessionId: string): void {
		this.sessions.delete(sessionId)
	}

	/**
	 * Classify one log line. Returns a `LineClassification` when the line is
	 * a failed github MCP tool_result whose owner matches a registered
	 * install, otherwise returns `null`. Never throws — parse errors, unknown
	 * envelopes, and network hiccups during the install-resolve probe all
	 * return `null` (or the classification with `installationResolves`
	 * treated as unknown).
	 *
	 * Log lines can arrive as either a single JSON envelope terminated by
	 * `\n` (the common case) or, less often, one envelope split across
	 * chunks. Callers must feed us complete lines — same contract as the
	 * `usage-parser` module.
	 */
	async classifyLine(sessionId: string, line: string): Promise<LineClassification | null> {
		const state = this.sessions.get(sessionId)
		if (!state) return null

		const trimmed = line.trim()
		if (trimmed.length === 0 || trimmed[0] !== '{') return null

		let envelope: unknown
		try {
			envelope = JSON.parse(trimmed)
		} catch {
			return null
		}
		if (!isRecord(envelope)) return null

		const type = envelope.type
		if (type === 'assistant') {
			this.rememberToolUses(state, envelope)
			return null
		}
		if (type === 'user') {
			return await this.tryClassifyToolResult(state, envelope)
		}
		return null
	}

	private rememberToolUses(state: SessionState, envelope: Record<string, unknown>): void {
		const message = envelope.message
		if (!isRecord(message)) return
		const content = message.content
		if (!Array.isArray(content)) return
		for (const block of content) {
			if (!isRecord(block)) continue
			if (block.type !== 'tool_use') continue
			const id = asString(block.id)
			const name = asString(block.name)
			if (!id || !name) continue
			if (!name.startsWith(GITHUB_MCP_TOOL_PREFIX)) continue
			// Evict oldest when the map grows unbounded — an agent that emits
			// tool_use without a matching tool_result must not leak memory.
			if (state.pendingToolUses.size >= MAX_PENDING_TOOL_USES) {
				const oldest = state.pendingToolUses.keys().next().value
				if (oldest !== undefined) state.pendingToolUses.delete(oldest)
			}
			state.pendingToolUses.set(id, name)
		}
	}

	private async tryClassifyToolResult(
		state: SessionState,
		envelope: Record<string, unknown>,
	): Promise<LineClassification | null> {
		const message = envelope.message
		if (!isRecord(message)) return null
		const content = message.content
		if (!Array.isArray(content)) return null
		for (const block of content) {
			if (!isRecord(block)) continue
			if (block.type !== 'tool_result') continue
			if (block.is_error !== true) {
				// Evict the mapping for successful tool calls so the map stays small.
				const okId = asString(block.tool_use_id)
				if (okId) state.pendingToolUses.delete(okId)
				continue
			}
			const toolUseId = asString(block.tool_use_id)
			if (!toolUseId) continue
			const toolName = state.pendingToolUses.get(toolUseId)
			state.pendingToolUses.delete(toolUseId)
			if (!toolName) continue
			if (!toolName.startsWith(GITHUB_MCP_TOOL_PREFIX)) continue
			const install = pickInstallForTool(state, toolName)
			const bodyText = extractResultText(block.content)
			return await this.classify(toolName, install, bodyText)
		}
		return null
	}

	private async classify(
		toolName: string,
		install: SessionGithubInstall | undefined,
		bodyText: string,
	): Promise<LineClassification> {
		const status = extractStatusFromMessage(bodyText)
		let installationResolves: boolean | undefined
		if (status === 401 && install) {
			try {
				installationResolves = await this.resolveInstallation(install.installationId)
			} catch (err) {
				logger.warn('resolveInstallation probe failed during log classification', {
					installationId: install.installationId,
					error: err instanceof Error ? err.message : String(err),
				})
				// Same conservative reading the wrapper uses: a probe that itself
				// errors on a 401 is a strong signal the ID no longer resolves.
				installationResolves = false
			}
		}
		const classified = classifyGithubError(
			{
				hadToken: Boolean(install?.tokenMetadata.token),
				status,
				body: bodyText,
			},
			{
				tokenMeta: install?.tokenMetadata,
				installationResolves,
			},
		)
		const taggedLine = formatTaggedLine(toolName, classified)
		return { taggedLine, classified, tool: toolName }
	}
}

function pickInstallForTool(
	state: SessionState,
	toolName: string,
): SessionGithubInstall | undefined {
	// tool name shape: mcp__github-<owner-lowercase>__<tool>
	const rest = toolName.slice(GITHUB_MCP_TOOL_PREFIX.length)
	const sepIdx = rest.indexOf('__')
	const owner = sepIdx === -1 ? rest : rest.slice(0, sepIdx)
	return state.installsByOwner.get(owner.toLowerCase())
}

function extractResultText(content: unknown): string {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	const pieces: string[] = []
	for (const block of content) {
		if (!isRecord(block)) continue
		if (block.type === 'text') {
			const text = asString(block.text)
			if (text) pieces.push(text)
		}
	}
	return pieces.join('\n')
}

function extractStatusFromMessage(msg: string | undefined): number | undefined {
	if (!msg) return undefined
	const match = msg.match(/\b(4\d\d|5\d\d)\b/)
	if (!match) return undefined
	const n = Number(match[1])
	return Number.isFinite(n) ? n : undefined
}

function formatTaggedLine(tool: string, classified: ClassifiedError): string {
	const parts = ['[github-cause-tag]', `tool=${tool}`, `cause_tag=${classified.cause_tag}`]
	if (classified.secondary_cause) parts.push(`secondary_cause=${classified.secondary_cause}`)
	if (classified.installation_id) parts.push(`installation_id=${classified.installation_id}`)
	if (classified.mint_age_seconds !== undefined) {
		parts.push(`mint_age_seconds=${classified.mint_age_seconds}`)
	}
	return parts.join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

/**
 * Process-wide singleton used by `session-manager.ts`. A single instance is
 * fine — state is keyed by `sessionId` and cleared on session termination.
 */
export const sessionGithubLogClassifier = new SessionGithubLogClassifier()

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ToolGrants } from '@maskin/shared'
import { grantEffect } from './extensions'

/**
 * Launch-side half of the tool guard for custom extensions (the wrapper itself
 * is docker/agent-base/maskin-mcp-guard.js). Everything here is pure so the
 * launch path and the report endpoint can share it.
 */

/** Where the agent image installs the wrapper (docker/agent-base/Dockerfile). */
export const GUARD_BIN = '/usr/local/bin/maskin-mcp-guard'

/** A session key stays valid this long after its session ends. */
export const GUARD_KEY_GRACE_MS = 60_000

const KEY_PREFIX = 'mgk1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GuardPolicy = { allow: string[]; deny: string[] }

/**
 * Allowlist for one agent on one extension. An agent with no entry gets empty
 * lists, which the wrapper reads as "deny every tool". Expiry on the object
 * form of a grant is not enforced yet.
 */
export function buildGuardPolicy(toolGrants: ToolGrants | null, agentId: string): GuardPolicy {
	const allow: string[] = []
	const deny: string[] = []
	const grants = toolGrants?.[agentId]
	if (!grants) return { allow, deny }
	for (const [tool, grant] of Object.entries(grants)) {
		if (grantEffect(grant) === 'allow') allow.push(tool)
		else deny.push(tool)
	}
	return { allow, deny }
}

type StdioServer = {
	command: string
	args?: string[]
	env?: Record<string, string>
	[key: string]: unknown
}

function isStdioServer(server: unknown): server is StdioServer {
	if (!server || typeof server !== 'object') return false
	const { command, type } = server as { command?: unknown; type?: unknown }
	return typeof command === 'string' && (type === undefined || type === 'stdio')
}

/**
 * Start the wrapper first and the real server as its child:
 *   npx mcp-remote URL  ->  maskin-mcp-guard -- npx mcp-remote URL
 * Returns null for a server the wrapper cannot front (anything but stdio), so
 * the caller drops it instead of running it unguarded. The guard settings go in
 * the server's env block, never in args, and the wrapper strips them before it
 * starts the child.
 */
export function guardServer(
	server: unknown,
	policy: GuardPolicy,
	opts: { reportUrl: string; sessionKey: string },
): StdioServer | null {
	if (!isStdioServer(server)) return null
	return {
		...server,
		command: GUARD_BIN,
		args: ['--', server.command, ...(server.args ?? [])],
		env: {
			...(server.env ?? {}),
			MASKIN_GUARD_ALLOW: JSON.stringify(policy.allow),
			MASKIN_GUARD_DENY: JSON.stringify(policy.deny),
			MASKIN_GUARD_REPORT_URL: opts.reportUrl,
			MASKIN_GUARD_SESSION_KEY: opts.sessionKey,
		},
	}
}

export function hashGuardKey(key: string): string {
	return createHash('sha256').update(key).digest('hex')
}

/**
 * One key per (session, extension). The ids in the key only locate the stored
 * hash; the random tail is what proves the caller holds the key, and the report
 * endpoint takes session and extension from the key, never from the body.
 */
export function mintGuardKey(
	sessionId: string,
	extensionId: string,
): { key: string; hash: string } {
	const key = `${KEY_PREFIX}.${sessionId}.${extensionId}.${randomBytes(32).toString('base64url')}`
	return { key, hash: hashGuardKey(key) }
}

export function parseGuardKey(key: string): { sessionId: string; extensionId: string } | null {
	const parts = key.split('.')
	if (parts.length !== 4) return null
	const [prefix, sessionId, extensionId, secret] = parts
	if (prefix !== KEY_PREFIX || !secret) return null
	// The ids go straight into a uuid column lookup, so anything else is a bad key, not a 500.
	if (!sessionId || !extensionId || !UUID_RE.test(sessionId) || !UUID_RE.test(extensionId)) {
		return null
	}
	return { sessionId, extensionId }
}

export function guardKeyMatches(key: string, storedHash: unknown): boolean {
	if (typeof storedHash !== 'string') return false
	const a = Buffer.from(hashGuardKey(key), 'hex')
	const b = Buffer.from(storedHash, 'hex')
	return a.length === b.length && timingSafeEqual(a, b)
}

/** True once a session has ended and its grace window has passed. */
export function guardKeyExpired(
	session: { status: string; completedAt: Date | null; updatedAt: Date | null },
	terminalStatuses: readonly string[],
	now: number = Date.now(),
): boolean {
	if (!terminalStatuses.includes(session.status)) return false
	const ended = session.completedAt ?? session.updatedAt
	if (!ended) return true
	const endedAt = ended.getTime()
	return now - endedAt > GUARD_KEY_GRACE_MS
}

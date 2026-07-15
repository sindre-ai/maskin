#!/usr/bin/env -S tsx
/**
 * bet-surface-probe-check — CI gate that blocks a PR from advancing a bet
 * to `active` or `live` when the bet's `metadata.surface_probe_verdict`
 * is unset, `miss_open`, or `unverified`.
 *
 * Resolves bets from `Bet-ID:` trailers in the PR body and/or explicit
 * `--bet <uuid>` flags, then reads each bet's metadata from the Maskin API.
 *
 * Contract fixed in T1 (see task 19e956f8-dce5-48b4-b672-b09a686ceb49):
 *   - Trailer regex: /^Bet-ID:\s*<uuid>\s*$/m
 *   - Trailer is MANDATORY when head branch matches /^bet\//
 *   - Endpoint: GET https://maskin.io/api/objects/<bet-id>
 *   - Headers: Authorization: Bearer $MASKIN_API_KEY, X-Workspace-Id: $MASKIN_WORKSPACE_ID
 *
 * Exit 0 when every named bet is `pass` or `miss_resolved`; exit 1 otherwise.
 * Fails closed on any Maskin API error — a transient network blip defeats
 * the gate if we let it pass.
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'

export const BET_ID_TRAILER_RE =
	/^Bet-ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/gim
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BET_HEAD_BRANCH_RE = /^bet\//
export const DEFAULT_API_BASE = 'https://maskin.io'

const PASSING_VERDICTS = new Set(['pass', 'miss_resolved'])
const KNOWN_FAILING_VERDICTS = new Set(['unset', 'miss_open', 'unverified'])

export type Verdict = 'pass' | 'miss_resolved' | 'unset' | 'miss_open' | 'unverified'

export interface BetLookup {
	id: string
	title: string | null
	verdict: string | null
}

export interface CheckResult {
	ok: boolean
	line: string
}

/** Extract all Bet-ID trailer values from a PR body. Deduped, order-preserving, lowercased. */
export function extractBetIds(prBody: string): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const match of prBody.matchAll(BET_ID_TRAILER_RE)) {
		const id = match[1]?.toLowerCase()
		if (!id || seen.has(id)) continue
		seen.add(id)
		out.push(id)
	}
	return out
}

/** True if the head branch signals a bet-advancing PR (trailer required). */
export function requiresTrailer(headBranch: string | undefined): boolean {
	return headBranch !== undefined && BET_HEAD_BRANCH_RE.test(headBranch)
}

/** Turn one bet lookup into an ok/line pair. Pure — no I/O. */
export function evaluateBet(bet: BetLookup): CheckResult {
	const label = bet.title ? `bet ${bet.title} (${bet.id})` : `bet (${bet.id})`
	const verdict = bet.verdict
	if (verdict !== null && PASSING_VERDICTS.has(verdict)) {
		return { ok: true, line: `pass — ${label}: surface_probe_verdict=${verdict}` }
	}
	// Anything not in the passing set — including null (unset), the known failing
	// values, and any unknown value — fails closed. A misconfigured verdict is not
	// a green light.
	const reported = verdict ?? 'unset'
	const normalised =
		verdict === null || KNOWN_FAILING_VERDICTS.has(verdict)
			? reported
			: `unverified (raw=${reported})`
	return {
		ok: false,
		line: `fail — ${label}: surface_probe_verdict=${normalised}, cannot advance to active/live`,
	}
}

interface FetchBetOptions {
	apiBase: string
	apiKey: string
	workspaceId: string
	fetchImpl?: typeof fetch
}

/**
 * Read one bet from the Maskin API. Returns:
 *   { kind: 'ok', bet }                — 200 with metadata parsed
 *   { kind: 'unresolvable', status }   — 404
 *   { kind: 'api_error', detail }      — any other non-2xx or network error
 */
export async function fetchBet(
	betId: string,
	opts: FetchBetOptions,
): Promise<
	| { kind: 'ok'; bet: BetLookup }
	| { kind: 'unresolvable'; status: number }
	| { kind: 'api_error'; detail: string }
> {
	const url = `${opts.apiBase.replace(/\/$/, '')}/api/objects/${betId}`
	const doFetch = opts.fetchImpl ?? fetch
	let res: Response
	try {
		res = await doFetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				'X-Workspace-Id': opts.workspaceId,
				Accept: 'application/json',
			},
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { kind: 'api_error', detail: `network error: ${msg}` }
	}
	if (res.status === 404) {
		return { kind: 'unresolvable', status: 404 }
	}
	if (!res.ok) {
		let bodySnippet = ''
		try {
			const text = await res.text()
			bodySnippet = text.length > 200 ? `${text.slice(0, 200)}…` : text
		} catch {}
		const detail = bodySnippet
			? `${res.status} ${res.statusText}: ${bodySnippet}`
			: `${res.status} ${res.statusText}`
		return { kind: 'api_error', detail }
	}
	let payload: unknown
	try {
		payload = await res.json()
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { kind: 'api_error', detail: `invalid JSON in 200 response: ${msg}` }
	}
	const parsed = parseBetPayload(betId, payload)
	if (!parsed) {
		return { kind: 'api_error', detail: `unexpected response shape for bet ${betId}` }
	}
	return { kind: 'ok', bet: parsed }
}

function parseBetPayload(id: string, payload: unknown): BetLookup | null {
	if (!payload || typeof payload !== 'object') return null
	const obj = payload as Record<string, unknown>
	const title = typeof obj.title === 'string' ? obj.title : null
	const metadata = obj.metadata
	let verdict: string | null = null
	if (metadata && typeof metadata === 'object') {
		const raw = (metadata as Record<string, unknown>).surface_probe_verdict
		if (typeof raw === 'string') verdict = raw
	}
	return { id, title, verdict }
}

export interface CheckBetsOptions {
	apiBase: string
	apiKey: string
	workspaceId: string
	fetchImpl?: typeof fetch
}

export interface CheckBetsOutcome {
	ok: boolean
	lines: string[]
}

/**
 * Check every bet ID against the Maskin API and produce one line per bet
 * (plus one line for any API error). ok=true iff every named bet is
 * pass/miss_resolved AND every request succeeded.
 */
export async function checkBets(
	betIds: string[],
	opts: CheckBetsOptions,
): Promise<CheckBetsOutcome> {
	const lines: string[] = []
	let ok = true
	for (const id of betIds) {
		const result = await fetchBet(id, opts)
		if (result.kind === 'ok') {
			const evald = evaluateBet(result.bet)
			lines.push(evald.line)
			if (!evald.ok) ok = false
		} else if (result.kind === 'unresolvable') {
			lines.push(
				`fail — bet (${id}): unresolvable (${result.status}), cannot advance to active/live`,
			)
			ok = false
		} else {
			lines.push(`fail — cannot reach Maskin API for bet ${id}: ${result.detail}`)
			ok = false
		}
	}
	return { ok, lines }
}

export interface ParsedArgs {
	bets: string[]
	prBody?: string
	prBodyFile?: string
	headBranch?: string
	help: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = { bets: [], help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--help' || arg === '-h') {
			out.help = true
			continue
		}
		if (arg === '--bet') {
			const value = argv[++i]
			if (!value) throw new Error('--bet requires a UUID value')
			if (!UUID_RE.test(value)) throw new Error(`--bet value is not a UUID: ${value}`)
			out.bets.push(value.toLowerCase())
			continue
		}
		if (arg === '--pr-body') {
			const value = argv[++i]
			if (value === undefined) throw new Error('--pr-body requires a value')
			out.prBody = value
			continue
		}
		if (arg === '--pr-body-file') {
			const value = argv[++i]
			if (!value) throw new Error('--pr-body-file requires a path')
			out.prBodyFile = value
			continue
		}
		if (arg === '--head-branch') {
			const value = argv[++i]
			if (value === undefined) throw new Error('--head-branch requires a value')
			out.headBranch = value
			continue
		}
		throw new Error(`unknown argument: ${arg}`)
	}
	return out
}

const USAGE = `Usage: bet-surface-probe-check [options]

Options:
  --bet <uuid>            Bet ID to check (repeatable)
  --pr-body <string>      PR body to extract Bet-ID trailers from
  --pr-body-file <path>   File containing the PR body
  --head-branch <name>    Head branch (if it matches ^bet/, a Bet-ID trailer is required)
  -h, --help              Show usage

Env:
  MASKIN_API_KEY          Required — Maskin workspace API key
  MASKIN_WORKSPACE_ID     Required — Maskin workspace UUID
  MASKIN_API_URL          Optional — defaults to ${DEFAULT_API_BASE}
`

function requireEnv(name: string): string {
	const raw = process.env[name]?.trim()
	if (!raw) {
		process.stderr.write(`missing required env var: ${name}\n`)
		process.exit(2)
	}
	return raw
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	let args: ParsedArgs
	try {
		args = parseArgs(argv)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		process.stderr.write(`${msg}\n\n${USAGE}`)
		return 2
	}
	if (args.help) {
		process.stdout.write(USAGE)
		return 0
	}

	// Merge trailer-extracted bet IDs with explicit --bet flags. Explicit flags
	// come first so the operator's intent leads the output.
	const collected = [...args.bets]
	if (args.prBody !== undefined) {
		for (const id of extractBetIds(args.prBody)) if (!collected.includes(id)) collected.push(id)
	}
	if (args.prBodyFile) {
		let body: string
		try {
			body = await readFile(args.prBodyFile, 'utf8')
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			process.stderr.write(`cannot read --pr-body-file ${args.prBodyFile}: ${msg}\n`)
			return 2
		}
		for (const id of extractBetIds(body)) if (!collected.includes(id)) collected.push(id)
	}

	if (collected.length === 0) {
		if (requiresTrailer(args.headBranch)) {
			process.stdout.write(
				`fail — head branch ${args.headBranch} matches ^bet/ but no Bet-ID: trailer found in PR body, cannot advance to active/live\n`,
			)
			return 1
		}
		process.stdout.write(
			'pass — no Bet-ID trailers and head branch is not a bet branch, nothing to gate\n',
		)
		return 0
	}

	const apiKey = requireEnv('MASKIN_API_KEY')
	const workspaceId = requireEnv('MASKIN_WORKSPACE_ID')
	const apiBase = process.env.MASKIN_API_URL?.trim() || DEFAULT_API_BASE

	const outcome = await checkBets(collected, { apiBase, apiKey, workspaceId })
	for (const line of outcome.lines) process.stdout.write(`${line}\n`)
	return outcome.ok ? 0 : 1
}

// Only run when executed directly (not when imported by tests).
const invokedAsMain =
	process.argv[1] !== undefined &&
	(process.argv[1].endsWith('bet-surface-probe-check.ts') ||
		process.argv[1].endsWith('bet-surface-probe-check.js') ||
		process.argv[1].endsWith('bet-surface-probe-check'))

if (invokedAsMain) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(
				`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
			)
			process.exit(2)
		},
	)
}

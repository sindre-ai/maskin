#!/usr/bin/env node
// First test for the single-prompt agent builder bet.
// Runs 10 one-liners through /api/agent-builder/create against a live server,
// measures end-to-end pipeline latency, and rates hedging on the assembled
// system prompt. Prints a summary block with three DoD gates.
//
// Gates (from bet e7af9eab-4fd0-448e-b031-3ea597852a1b):
//   1. Underspec prompt (#7 "help me build an agent") returns gap_question,
//      no actor created.
//   2. p95 pipeline latency < 30_000 ms across the 9 well-specified prompts.
//   3. Hedging rate ≤ 10% of well-specified runs (≤ 1 of 9).

import { setTimeout as sleep } from 'node:timers/promises'

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000'
const API_KEY = process.env.API_KEY
const WORKSPACE_ID = process.env.WORKSPACE_ID

if (!API_KEY || !WORKSPACE_ID) {
	console.error('API_KEY and WORKSPACE_ID env vars are required')
	process.exit(2)
}

// Nine well-specified one-liners (varied domains) + one deliberately vague one.
// Index 6 (the 7th prompt, 1-based) is the underspec gate case.
const PROMPTS = [
	'Design a Postgres-to-BigQuery ETL that keeps a 500-table OLTP schema in sync every 15 minutes',
	'Write a launch-week marketing plan for a developer tool with a $5k ad budget and one week to ship',
	'Draft a Series A pitch deck outline for a vertical-SaaS startup targeting independent physical therapists',
	'Review our React 19 SSR streaming setup and recommend a caching layer that survives spiky traffic',
	'Plan a 12-week strength program for a 34-year-old lifter returning after a 6-month back injury',
	'Cost-optimize a k8s cluster running 40 microservices on GKE with a $12k/mo budget cap',
	'help me build an agent',
	'Diagnose a Node.js memory leak in a Fastify service that OOMs at ~2GB after 8 hours',
	'Write a data-retention policy for a healthcare SaaS handling PHI under HIPAA in the US',
	'Recommend a fixed-income allocation for a 62-year-old with $1.4M and a 10-year retirement horizon',
]

const UNDERSPEC_INDEX = 6

// Hedging phrases. Rated against the assembled system prompt returned by the
// pipeline (opinionation clause explicitly forbids these — appearance in a
// generated prompt indicates the opinionation layer didn't do its job).
// Word-boundary matched so "would" and "could" don't hit inside other words.
const HEDGING_PATTERNS = [
	/\bmight\b/i,
	/\bcould be\b/i,
	/\bcould\b/i,
	/\bit depends\b/i,
	/\bperhaps\b/i,
	/\bmaybe\b/i,
	/\bpossibly\b/i,
	/\bprobably\b/i,
]

// The opinionation clause itself teaches the agent by *quoting* hedging words
// it must forbid ("forbid hedging language ('might', 'could', 'it depends')").
// We rate hedging only on text OUTSIDE the response protocol section — the
// prohibition itself is not hedging.
function stripResponseProtocol(text) {
	const idx = text.indexOf('## Response protocol')
	return idx === -1 ? text : text.slice(0, idx)
}

function countHedges(text) {
	const scan = stripResponseProtocol(text)
	let hits = 0
	for (const re of HEDGING_PATTERNS) if (re.test(scan)) hits++
	return hits
}

async function callCreate(prompt) {
	const started = Date.now()
	let resp
	try {
		resp = await fetch(`${API_BASE}/api/agent-builder/create`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${API_KEY}`,
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify({ prompt }),
		})
	} catch (err) {
		return { ok: false, ms: Date.now() - started, error: `network: ${err?.message ?? err}` }
	}
	const ms = Date.now() - started
	let body
	try {
		body = await resp.json()
	} catch {
		body = { _parse_error: true, _status: resp.status }
	}
	return { ok: resp.ok, status: resp.status, ms, body }
}

function percentile(values, p) {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.ceil((p / 100) * sorted.length) - 1
	return sorted[Math.max(0, Math.min(rank, sorted.length - 1))]
}

async function main() {
	console.log(`First test — POST ${API_BASE}/api/agent-builder/create`)
	console.log(`Workspace: ${WORKSPACE_ID}\n`)

	const results = []
	for (let i = 0; i < PROMPTS.length; i++) {
		const prompt = PROMPTS[i]
		const label = i === UNDERSPEC_INDEX ? '(underspec)' : ''
		process.stdout.write(`  #${i + 1}/10 ${label} "${prompt.slice(0, 60)}..." … `)
		const r = await callCreate(prompt)
		results.push({ index: i, prompt, ...r })
		if (!r.ok) {
			console.log(`FAIL ${r.status ?? ''} ${r.ms}ms`)
			console.log('     body:', JSON.stringify(r.body).slice(0, 300))
		} else if (r.body.gap_question) {
			console.log(`gap_question ${r.ms}ms`)
		} else {
			const hedges = countHedges(r.body.system_prompt ?? '')
			console.log(`ok ${r.ms}ms hedges=${hedges}`)
		}
		// small polite delay so we don't hammer the LLM API
		await sleep(200)
	}

	// ── Gate 1: underspec returns gap_question, no actor created ──────────
	const underspec = results[UNDERSPEC_INDEX]
	const gate1Pass =
		underspec.ok &&
		typeof underspec.body?.gap_question === 'string' &&
		underspec.body.gap_question.length > 0 &&
		!underspec.body?.actor_id

	// ── Well-specified results only (indexes 0-9 except UNDERSPEC_INDEX) ─
	const wellSpec = results.filter((r, i) => i !== UNDERSPEC_INDEX)
	const wellSpecOk = wellSpec.filter((r) => r.ok && r.body?.actor_id)

	// ── Gate 2: p95 pipeline latency < 30 000 ms across the 9 ────────────
	const latencies = wellSpecOk.map((r) => r.ms)
	const p50 = percentile(latencies, 50)
	const p95 = percentile(latencies, 95)
	const p99 = percentile(latencies, 99)
	const gate2Pass = p95 !== null && p95 < 30_000 && wellSpecOk.length === wellSpec.length

	// ── Gate 3: hedging rate ≤ 10% (≤ 1 of 9) ────────────────────────────
	const hedgingCounts = wellSpecOk.map((r) => ({
		index: r.index,
		hedges: countHedges(r.body?.system_prompt ?? ''),
	}))
	const hedgedRuns = hedgingCounts.filter((h) => h.hedges > 0).length
	const gate3Pass = hedgedRuns <= 1 && wellSpecOk.length === wellSpec.length

	console.log('\n' + '─'.repeat(72))
	console.log('SUMMARY')
	console.log('─'.repeat(72))
	console.log(
		`Well-specified prompts:  ${wellSpecOk.length}/${wellSpec.length} succeeded`,
	)
	console.log(
		`Latency (well-specified): p50=${p50}ms  p95=${p95}ms  p99=${p99}ms`,
	)
	console.log(`Hedging rate:            ${hedgedRuns}/${wellSpec.length} runs contained hedging`)
	console.log()
	console.log(`Gate 1 (underspec → gap_question, no actor):   ${gate1Pass ? '✓ PASS' : '✗ FAIL'}`)
	console.log(`Gate 2 (p95 < 30 000 ms across 9 prompts):    ${gate2Pass ? '✓ PASS' : '✗ FAIL'}`)
	console.log(`Gate 3 (hedging ≤ 10% — max 1 of 9):          ${gate3Pass ? '✓ PASS' : '✗ FAIL'}`)
	console.log()

	if (hedgedRuns > 0) {
		console.log('Hedged runs (index → hit count):')
		for (const h of hedgingCounts.filter((h) => h.hedges > 0)) {
			console.log(`  #${h.index + 1} "${PROMPTS[h.index].slice(0, 60)}..." — ${h.hedges} pattern(s)`)
		}
		console.log()
	}

	for (const r of results) {
		if (!r.ok) {
			console.log(
				`Failed prompt #${r.index + 1}: status=${r.status ?? '-'} body=${JSON.stringify(r.body).slice(0, 300)}`,
			)
		}
	}

	const allPass = gate1Pass && gate2Pass && gate3Pass
	process.exit(allPass ? 0 : 1)
}

main().catch((err) => {
	console.error('first-test crashed:', err)
	process.exit(3)
})

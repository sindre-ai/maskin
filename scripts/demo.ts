/**
 * Demo Recording Script
 *
 * Drives the full Maskin Insight → Bet → Task cycle through the API with
 * timed delays, designed to be run while screen-recording the web UI.
 *
 * Usage:
 *   1. Start Maskin:  pnpm dev
 *   2. Seed data:     pnpm db:seed
 *   3. Log in as Demo User in the browser and open the Demo Workspace
 *   4. Run this script in a separate terminal:
 *        npx tsx scripts/demo.ts
 *   5. Screen-record the browser for 60-90 seconds
 *
 * The script creates objects with deliberate pauses so each step is visible
 * on screen before the next one begins.
 *
 * Environment variables:
 *   API_URL        — Backend URL (default: http://localhost:3000)
 *   API_KEY        — Actor API key (auto-detected from Demo User if omitted)
 *   WORKSPACE_ID   — Workspace ID (auto-detected from Demo Workspace if omitted)
 *   PACE           — Delay multiplier (default: 1). Use 0.5 for faster, 2 for slower.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3000'
const PACE = Number(process.env.PACE ?? '1')

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms * PACE))
}

async function api<T = unknown>(
	method: string,
	path: string,
	body?: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<T> {
	const res = await fetch(`${API_URL}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`${method} ${path} → ${res.status}: ${text}`)
	}
	return res.json() as T
}

function log(icon: string, msg: string) {
	const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
	console.log(`  ${icon}  [${ts}]  ${msg}`)
}

// ── Auto-detect workspace & key ────────────────────────────────────────────

let apiKey = process.env.API_KEY ?? ''
let workspaceId = process.env.WORKSPACE_ID ?? ''

async function detectCredentials() {
	if (apiKey && workspaceId) return

	// List actors to find Demo User
	const actors = (await fetch(`${API_URL}/api/actors`).then((r) => r.json())) as Array<{
		id: string
		name: string
		apiKey?: string
	}>
	const demoUser = actors.find((a) => a.name === 'Demo User')
	if (!demoUser) throw new Error('Demo User not found — run pnpm db:seed first')
	if (!apiKey) apiKey = demoUser.apiKey ?? ''
	if (!apiKey) throw new Error('Could not detect API key for Demo User')

	// List workspaces to find Demo Workspace
	const workspaces = (await fetch(`${API_URL}/api/workspaces`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	}).then((r) => r.json())) as Array<{ id: string; name: string }>
	const demoWs = workspaces.find((w) => w.name === 'Demo Workspace')
	if (!demoWs) throw new Error('Demo Workspace not found — run pnpm db:seed first')
	if (!workspaceId) workspaceId = demoWs.id
}

// ── Demo Flow ──────────────────────────────────────────────────────────────

async function run() {
	console.log('\n  ╔══════════════════════════════════════════════╗')
	console.log('  ║       Maskin Demo — Self-Improving Loop      ║')
	console.log('  ╚══════════════════════════════════════════════╝\n')

	log('🔌', `Connecting to ${API_URL}`)
	await detectCredentials()
	log('✅', `Using workspace ${workspaceId}\n`)

	// ── Step 1: Customer feedback flows in as insights ──────────────────
	log('📥', 'STEP 1 — Customer feedback flowing in as insights')
	await sleep(2000)

	const insight1 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'insight',
		title: 'Users request bulk CSV export for analytics',
		content:
			'Multiple enterprise customers have asked for the ability to export workspace data as CSV. This was mentioned in 4 separate sales calls this week.',
		status: 'new',
	})
	log('💡', `Insight created: "Users request bulk CSV export" (${insight1.id.slice(0, 8)}…)`)
	await sleep(3000)

	const insight2 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'insight',
		title: 'Dashboard load time increased 40% after last deploy',
		content:
			'Monitoring shows P95 dashboard load went from 1.2s to 1.7s. Correlates with the new activity feed query. Users in #feedback Slack channel are complaining.',
		status: 'new',
	})
	log('💡', `Insight created: "Dashboard load time increased 40%" (${insight2.id.slice(0, 8)}…)`)
	await sleep(3000)

	const insight3 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'insight',
		title: 'Competitor launched AI-powered search feature',
		content:
			'Acme Corp just shipped semantic search across their workspace. Early reviews are positive. Three of our prospects mentioned it in evaluation calls.',
		status: 'new',
	})
	log('💡', `Insight created: "Competitor launched AI-powered search" (${insight3.id.slice(0, 8)}…)`)
	await sleep(4000)

	// ── Step 2: Agent analyzes insights and proposes a bet ──────────────
	log('🤖', 'STEP 2 — Agent analyzing insights and proposing a bet')
	await sleep(2000)

	// Update insights to "accepted" as if the agent processed them
	await api('PATCH', `/api/objects/${insight1.id}`, { status: 'accepted' })
	await api('PATCH', `/api/objects/${insight2.id}`, { status: 'accepted' })
	log('📊', 'Agent clustered 2 related insights (export + performance)')
	await sleep(2000)

	// Agent creates a bet
	const bet = await api<{ id: string }>('POST', '/api/objects', {
		type: 'bet',
		title: 'Ship data export MVP and fix dashboard performance',
		content:
			'Two signals converge: enterprise customers need data export, and the dashboard regression is hurting retention. Shipping a lightweight CSV export + optimizing the activity feed query addresses both. Expected impact: unblock 3 enterprise deals and restore sub-1.5s load times.',
		status: 'proposed',
	})
	log('🎯', `Bet proposed: "Ship data export MVP and fix performance" (${bet.id.slice(0, 8)}…)`)
	await sleep(2000)

	// Link insights to bet
	await api('POST', '/api/relationships', {
		sourceType: 'insight',
		sourceId: insight1.id,
		targetType: 'bet',
		targetId: bet.id,
		type: 'informs',
	})
	await api('POST', '/api/relationships', {
		sourceType: 'insight',
		sourceId: insight2.id,
		targetType: 'bet',
		targetId: bet.id,
		type: 'informs',
	})
	log('🔗', 'Linked insights to bet')
	await sleep(2000)

	// Promote bet to active
	await api('PATCH', `/api/objects/${bet.id}`, { status: 'active' })
	log('✅', 'Bet promoted to active')
	await sleep(4000)

	// ── Step 3: Agent breaks the bet into tasks ─────────────────────────
	log('🔨', 'STEP 3 — Agent breaking the bet into tasks')
	await sleep(2000)

	const task1 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'task',
		title: 'Add CSV export endpoint to /api/objects',
		content:
			'Create GET /api/objects/export?format=csv endpoint. Stream results to avoid memory issues on large workspaces. Include title, type, status, created, updated columns.',
		status: 'todo',
	})
	log('📋', `Task: "Add CSV export endpoint" (${task1.id.slice(0, 8)}…)`)
	await sleep(2000)

	const task2 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'task',
		title: 'Optimize activity feed query — add index on events.created_at',
		content:
			'The activity feed query does a seq scan on events table. Add a composite index on (workspace_id, created_at DESC) and rewrite the query to use it.',
		status: 'todo',
	})
	log('📋', `Task: "Optimize activity feed query" (${task2.id.slice(0, 8)}…)`)
	await sleep(2000)

	const task3 = await api<{ id: string }>('POST', '/api/objects', {
		type: 'task',
		title: 'Add export button to workspace toolbar',
		content: 'Add a "Download CSV" button to the objects list header. Use the new export endpoint.',
		status: 'todo',
	})
	log('📋', `Task: "Add export button to toolbar" (${task3.id.slice(0, 8)}…)`)
	await sleep(1500)

	// Link tasks to bet
	for (const task of [task1, task2, task3]) {
		await api('POST', '/api/relationships', {
			sourceType: 'bet',
			sourceId: bet.id,
			targetType: 'task',
			targetId: task.id,
			type: 'breaks_into',
		})
	}
	log('🔗', 'Linked all tasks to bet')
	await sleep(4000)

	// ── Step 4: Tasks being executed by agents ──────────────────────────
	log('⚡', 'STEP 4 — Tasks being executed by agents')
	await sleep(2000)

	await api('PATCH', `/api/objects/${task2.id}`, { status: 'in_progress' })
	log('🏃', 'Agent picked up: "Optimize activity feed query"')
	await sleep(3000)

	await api('PATCH', `/api/objects/${task2.id}`, { status: 'done' })
	log('✅', 'Task completed: "Optimize activity feed query"')
	await sleep(2000)

	await api('PATCH', `/api/objects/${task1.id}`, { status: 'in_progress' })
	log('🏃', 'Agent picked up: "Add CSV export endpoint"')
	await sleep(3000)

	await api('PATCH', `/api/objects/${task1.id}`, { status: 'done' })
	log('✅', 'Task completed: "Add CSV export endpoint"')
	await sleep(4000)

	// ── Step 5: Workspace Observer — the self-improving loop ────────────
	log('🔄', 'STEP 5 — Workspace Observer: the self-improving loop')
	await sleep(2000)

	const metaInsight = await api<{ id: string }>('POST', '/api/objects', {
		type: 'insight',
		title: '[Meta] Agents completed 2/3 tasks on "Data Export" bet in under 5 minutes',
		content:
			'Workspace Observer detected: The "Ship data export MVP" bet had 3 tasks. 2 were completed automatically by agents within minutes of creation. The remaining UI task requires human review. Suggestion: similar backend-heavy bets could be fully automated in the future. Consider adding auto-merge for low-risk agent PRs.',
		status: 'new',
		metadata: { tags: ['meta', 'self-improving', 'automation-opportunity'] },
	})
	log('🧠', `Meta-insight: "Agents completed 2/3 tasks automatically" (${metaInsight.id.slice(0, 8)}…)`)
	await sleep(2000)

	// Link meta-insight back to the bet, closing the loop
	await api('POST', '/api/relationships', {
		sourceType: 'insight',
		sourceId: metaInsight.id,
		targetType: 'bet',
		targetId: bet.id,
		type: 'informs',
	})
	log('🔗', 'Meta-insight linked back to bet — loop closed')
	await sleep(1000)

	console.log('\n  ╔══════════════════════════════════════════════╗')
	console.log('  ║          Demo complete! 🎬                   ║')
	console.log('  ╚══════════════════════════════════════════════╝')
	console.log('\n  The full cycle just played out:')
	console.log('    Insights → Agent clusters → Bet → Agent decomposes → Tasks')
	console.log('    → Agents execute → Observer creates meta-insight')
	console.log('    → Self-improving loop ♻️\n')
}

run().catch((err) => {
	console.error('\n  ❌ Demo failed:', err.message)
	process.exit(1)
})

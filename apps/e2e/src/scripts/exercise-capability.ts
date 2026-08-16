// Runtime evidence runner for T5 (agent capability card + grid pill).
//
// The web components consume `Capability` on the detail response and
// `CapabilityCompact` on the list response. Component tests already cover
// render-given-shape; this script covers the other half — that the real
// server actually emits those shapes against real Postgres for the
// scenarios the UI must handle (bare agent, human, upgraded agent, humans
// in a mixed list).
//
// Assumes the API is up. Reads API_BASE (default http://localhost:3000),
// API_KEY, WORKSPACE_ID from env. Prints one `{ok, steps[], evidence{}}`
// object per scenario and an overall summary line, exit 0 on all-ok.

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000'
const API_KEY = process.env.API_KEY
const WORKSPACE_ID = process.env.WORKSPACE_ID

if (!API_KEY || !WORKSPACE_ID) {
	console.error('Missing API_KEY or WORKSPACE_ID env')
	process.exit(2)
}

const authHeaders: Record<string, string> = {
	Authorization: `Bearer ${API_KEY}`,
	'X-Workspace-Id': WORKSPACE_ID,
}

interface Scenario {
	name: string
	run: () => Promise<{ steps: string[]; evidence: Record<string, unknown> }>
}

async function createActor(type: 'agent' | 'human', name: string) {
	const payload: Record<string, unknown> = { type, name }
	if (type === 'human') {
		payload.email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@exercise.local`
		payload.password = 'exercise-password-123'
	}
	const res = await fetch(`${API_BASE}/api/actors`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})
	if (!res.ok) throw new Error(`create ${type} ${res.status} ${await res.text()}`)
	return (await res.json()) as { id: string; name: string; api_key: string }
}

async function addMember(actorId: string) {
	const res = await fetch(`${API_BASE}/api/workspaces/${WORKSPACE_ID}/members`, {
		method: 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ actor_id: actorId, role: 'member' }),
	})
	if (!res.ok) throw new Error(`addMember ${res.status}`)
}

async function getActor(id: string) {
	const res = await fetch(`${API_BASE}/api/actors/${id}`, { headers: authHeaders })
	if (!res.ok) throw new Error(`GET actor ${res.status}`)
	return (await res.json()) as {
		id: string
		type: string
		capability: unknown
	}
}

async function patchActor(id: string, patch: Record<string, unknown>) {
	const res = await fetch(`${API_BASE}/api/actors/${id}`, {
		method: 'PATCH',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify(patch),
	})
	if (!res.ok) throw new Error(`PATCH actor ${res.status} ${await res.text()}`)
	return (await res.json()) as { id: string; capability: unknown }
}

async function listActors() {
	const res = await fetch(`${API_BASE}/api/actors`, { headers: authHeaders })
	if (!res.ok) throw new Error(`list ${res.status}`)
	return (await res.json()) as Array<{
		id: string
		type: string
		name: string
		capability?: unknown
	}>
}

const DIMS = ['expertise', 'skills', 'connectors', 'context', 'autonomy']

const scenarios: Scenario[] = [
	{
		name: 'bare agent detail — Novice + 5 dims + topGaps',
		async run() {
			const steps: string[] = []
			steps.push('POST /api/actors (agent, no system_prompt)')
			const bare = await createActor('agent', `BareExercise ${Date.now()}`)
			steps.push(`POST /api/workspaces/${WORKSPACE_ID}/members`)
			await addMember(bare.id)
			steps.push(`GET /api/actors/${bare.id}`)
			const full = await getActor(bare.id)
			const cap = full.capability as {
				overall: { level: string; score: number }
				dimensions: Array<{ key: string; score: number; label: string }>
				topGaps: Array<{ dimension: string; action: string; toolHint?: string }>
			}
			const dimKeys = cap.dimensions.map((d) => d.key).sort()
			const expected = [...DIMS].sort()
			if (cap.overall.level !== 'novice') throw new Error(`level ${cap.overall.level}, want novice`)
			if (JSON.stringify(dimKeys) !== JSON.stringify(expected))
				throw new Error(`dims ${dimKeys.join(',')}`)
			if (cap.topGaps.length < 1) throw new Error(`topGaps ${cap.topGaps.length}`)
			return {
				steps,
				evidence: {
					actorId: bare.id,
					level: cap.overall.level,
					score: cap.overall.score,
					dimensions: dimKeys,
					topGapCount: cap.topGaps.length,
					firstGap: cap.topGaps[0],
				},
			}
		},
	},
	{
		name: 'human actor detail — capability=null (card must not render)',
		async run() {
			const steps: string[] = []
			steps.push('POST /api/actors (human)')
			const human = await createActor('human', `HumanExercise ${Date.now()}`)
			steps.push(`POST /api/workspaces/${WORKSPACE_ID}/members`)
			await addMember(human.id)
			steps.push(`GET /api/actors/${human.id}`)
			const full = await getActor(human.id)
			if (full.capability !== null)
				throw new Error(`human capability ${JSON.stringify(full.capability)}`)
			return { steps, evidence: { actorId: human.id, capability: full.capability } }
		},
	},
	{
		name: 'PATCH response body carries updated capability snapshot',
		async run() {
			const steps: string[] = []
			steps.push('POST /api/actors (agent)')
			const a = await createActor('agent', `PatchExercise ${Date.now()}`)
			steps.push(`POST /api/workspaces/${WORKSPACE_ID}/members`)
			await addMember(a.id)
			steps.push('PATCH /api/actors/:id set a substantive system prompt')
			const prompt =
				'You are the workspace coach. Teach humans how to shape bets, decide edges, ' +
				'and coordinate agents. Explain the object model, the reasoning loop, and the ' +
				'tradeoffs between speed and quality.'
			const patchResponse = await patchActor(a.id, { system_prompt: prompt })
			// PATCH is claimed to return the updated snapshot directly — assert that
			// contract before falling back to a GET, so a regression that drops
			// capability from the PATCH response body actually fails this scenario.
			if (!patchResponse.capability)
				throw new Error(
					`PATCH response missing capability: ${JSON.stringify(patchResponse.capability)}`,
				)
			const patchCap = patchResponse.capability as {
				overall: { level: string; score: number }
				dimensions: Array<{ key: string; score: number; reasons: string[] }>
			}
			if (typeof patchCap.overall?.score !== 'number')
				throw new Error(`PATCH capability.overall.score not a number: ${patchCap.overall?.score}`)
			const patchDimKeys = patchCap.dimensions.map((d) => d.key).sort()
			const expected = [...DIMS].sort()
			if (JSON.stringify(patchDimKeys) !== JSON.stringify(expected))
				throw new Error(`PATCH dims: ${patchDimKeys.join(',')}`)
			const patchExpertise = patchCap.dimensions.find((d) => d.key === 'expertise')
			if (!patchExpertise || patchExpertise.score <= 0)
				throw new Error(`PATCH expertise dim not scored: ${JSON.stringify(patchExpertise)}`)
			steps.push(`GET /api/actors/${a.id} (parity check: GET matches PATCH snapshot)`)
			const patched = await getActor(a.id)
			const getCap = patched.capability as {
				overall: { level: string; score: number }
				dimensions: Array<{ key: string; score: number; reasons: string[] }>
			}
			if (getCap.overall.score !== patchCap.overall.score)
				throw new Error(
					`GET score ${getCap.overall.score} != PATCH score ${patchCap.overall.score}`,
				)
			if (getCap.overall.level !== patchCap.overall.level)
				throw new Error(
					`GET level ${getCap.overall.level} != PATCH level ${patchCap.overall.level}`,
				)
			return {
				steps,
				evidence: {
					actorId: a.id,
					patchLevel: patchCap.overall.level,
					patchScore: patchCap.overall.score,
					patchExpertiseScore: patchExpertise.score,
					patchExpertiseReasons: patchExpertise.reasons,
					patchDimensions: patchDimKeys,
					getLevel: getCap.overall.level,
					getScore: getCap.overall.score,
				},
			}
		},
	},
	{
		name: 'list endpoint — agents carry compact chip, humans do not',
		async run() {
			const steps: string[] = []
			steps.push('GET /api/actors')
			const list = await listActors()
			const agents = list.filter((a) => a.type === 'agent')
			const humans = list.filter((a) => a.type === 'human')
			const chippedAgents = agents.filter(
				(a) => a.capability && typeof (a.capability as { level?: string }).level === 'string',
			)
			const chipShape = chippedAgents[0]?.capability as {
				level: string
				score: number
				topGapCount: number
			}
			const humansMissingChip = humans.filter((h) => !h.capability)
			if (agents.length && chippedAgents.length === 0)
				throw new Error('no agents in list carry a capability chip')
			if (chipShape) {
				const keys = Object.keys(chipShape).sort()
				const want = ['level', 'score', 'topGapCount']
				for (const k of want) if (!keys.includes(k)) throw new Error(`chip missing ${k}`)
			}
			return {
				steps,
				evidence: {
					totalActors: list.length,
					agents: agents.length,
					humans: humans.length,
					agentsWithChip: chippedAgents.length,
					humansMissingChipCount: humansMissingChip.length,
					sampleChip: chipShape,
				},
			}
		},
	},
]
;(async () => {
	const results: Array<{
		name: string
		ok: boolean
		steps: string[]
		evidence: unknown
		error?: string
	}> = []
	let allOk = true
	for (const sc of scenarios) {
		try {
			const { steps, evidence } = await sc.run()
			const line = { name: sc.name, ok: true, steps, evidence }
			results.push(line)
			console.log(JSON.stringify(line))
		} catch (e) {
			allOk = false
			const line = {
				name: sc.name,
				ok: false,
				steps: [],
				evidence: {},
				error: e instanceof Error ? e.message : String(e),
			}
			results.push(line)
			console.log(JSON.stringify(line))
		}
	}
	console.log(
		JSON.stringify({ ok: allOk, summary: 'agent-capability exercise', scenarios: results.length }),
	)
	process.exit(allOk ? 0 : 1)
})()

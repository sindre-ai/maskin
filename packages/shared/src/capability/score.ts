import { PROMPT_DEEP_LENGTH, PROMPT_MIN_LENGTH, critiqueSystemPrompt } from './critique'
import type {
	AgentCapability,
	AgentCapabilitySnapshot,
	CapabilityDimension,
	CapabilityDimensionKey,
	CapabilityGap,
	CapabilityLevel,
	CapabilityScore,
	UnresolvedPlaceholder,
} from './types'

// Deterministic capability rubric. All thresholds live here so the number a user
// sees in the MCP client, the web app, and the builder preview is always the same.

export const CAPABILITY_RUBRIC: Record<CapabilityDimensionKey, { label: string; weight: number }> =
	{
		expertise: { label: 'Expertise', weight: 35 },
		skills: { label: 'Skills', weight: 20 },
		connectors: { label: 'Connectors', weight: 20 },
		context: { label: 'Context', weight: 10 },
		autonomy: { label: 'Autonomy', weight: 15 },
	}

export const CAPABILITY_LEVELS: { level: CapabilityLevel; min: number }[] = [
	{ level: 'master', min: 85 },
	{ level: 'expert', min: 65 },
	{ level: 'practitioner', min: 40 },
	{ level: 'apprentice', min: 20 },
	{ level: 'novice', min: 0 },
]

export const TOP_GAPS_LIMIT = 5

/** The `maskin` platform MCP preset is auto-injected on every agent — it earns no points. */
const PLATFORM_SERVER_NAME = 'maskin'

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function scoreAgentCapability(snapshot: AgentCapabilitySnapshot): AgentCapability {
	const unresolvedPlaceholders = findUnresolvedPlaceholders(snapshot)

	const dimensions: CapabilityDimension[] = [
		scoreExpertise(snapshot),
		scoreSkills(snapshot),
		scoreConnectors(snapshot, unresolvedPlaceholders),
		scoreContext(snapshot),
		scoreAutonomy(snapshot),
	]

	const score = Math.round(
		dimensions.reduce((sum, dim) => sum + (dim.score / 5) * CAPABILITY_RUBRIC[dim.key].weight, 0),
	)

	return {
		version: 1,
		overall: { score, level: levelFor(score) },
		dimensions,
		unresolvedPlaceholders,
		topGaps: pickTopGaps(dimensions),
	}
}

export function levelFor(score: number): CapabilityLevel {
	for (const { level, min } of CAPABILITY_LEVELS) {
		if (score >= min) return level
	}
	return 'novice'
}

function scoreExpertise(snapshot: AgentCapabilitySnapshot): CapabilityDimension {
	const prompt = snapshot.systemPrompt ?? ''
	const criteria = critiqueSystemPrompt(prompt)
	const passed = new Set(criteria.filter((c) => c.pass).map((c) => c.id))
	const reasons: string[] = []
	const gaps: CapabilityGap[] = []

	let score: CapabilityScore
	if (prompt.length === 0) {
		score = 0
		gaps.push({
			action: 'expand_system_prompt',
			detail: 'No instructions at all — the agent is a blank generic LLM.',
			toolHint: 'update_actor',
		})
	} else if (prompt.length < PROMPT_MIN_LENGTH) {
		score = 1
		reasons.push('Has minimal instructions')
		gaps.push({
			action: 'expand_system_prompt',
			detail: `Instructions are only ${prompt.length} characters — expand into a real SME briefing.`,
			toolHint: 'update_actor',
		})
	} else if (!passed.has('length') || !passed.has('structure')) {
		score = 2
		reasons.push('Has instructions')
		if (!passed.has('structure')) {
			gaps.push({
				action: 'add_structure',
				detail:
					'Organize instructions into sections: role, scope, decision framework, output format.',
				toolHint: 'update_actor',
			})
		}
		if (!passed.has('length')) {
			gaps.push({
				action: 'expand_system_prompt',
				detail: 'Deepen the instructions — cover scope, rules, and expected output.',
				toolHint: 'update_actor',
			})
		}
	} else if (!passed.has('decision_framework') && !passed.has('stance')) {
		score = 3
		reasons.push('Structured, substantial instructions')
		gaps.push({
			action: 'add_stance',
			detail:
				'Add a decision framework and a stance: when/then rules, priorities, and "recommend, don\'t hedge" instructions.',
			toolHint: 'update_actor',
		})
	} else if (!passed.has('examples') || prompt.length < PROMPT_DEEP_LENGTH) {
		score = 4
		reasons.push('Structured instructions with decision rules')
		gaps.push({
			action: 'add_examples',
			detail:
				'Add concrete worked examples (✅/❌ pairs or fenced blocks) showing expected output.',
			toolHint: 'update_actor',
		})
	} else {
		score = 5
		reasons.push('Deep, structured, opinionated instructions with examples')
	}

	if (score >= 3 && !passed.has('stance')) {
		gaps.push({
			action: 'add_stance',
			detail:
				'Add stance-forcing language: give a recommendation, state assumptions, do not hedge.',
			toolHint: 'update_actor',
		})
	}

	return { key: 'expertise', label: CAPABILITY_RUBRIC.expertise.label, score, reasons, gaps }
}

function scoreSkills(snapshot: AgentCapabilitySnapshot): CapabilityDimension {
	const count = snapshot.skillCount
	const reasons: string[] = []
	const gaps: CapabilityGap[] = []

	let score = countScale(count, [0, 2, 3, 4, 4, 5])
	if (count > 0) reasons.push(`${count} skill${count === 1 ? '' : 's'} attached`)

	if (snapshot.invalidSkillCount > 0) {
		score = Math.max(0, score - 1) as CapabilityScore
		gaps.push({
			action: 'attach_skill',
			detail: `${snapshot.invalidSkillCount} attached skill(s) failed validation and won't load — fix or replace them.`,
			toolHint: 'update_workspace_skill',
		})
	}
	if (count === 0) {
		gaps.push({
			action: 'attach_skill',
			detail:
				'No skills attached — attach workspace skills so the agent has proven procedures to follow.',
			toolHint: 'update_actor',
		})
	} else if (score < 5) {
		gaps.push({
			action: 'attach_skill',
			detail: "Attach more skills covering the agent's recurring workflows.",
			toolHint: 'update_actor',
		})
	}

	return { key: 'skills', label: CAPABILITY_RUBRIC.skills.label, score, reasons, gaps }
}

function scoreConnectors(
	snapshot: AgentCapabilitySnapshot,
	unresolved: UnresolvedPlaceholder[],
): CapabilityDimension {
	const servers = Object.keys(snapshot.mcpServers ?? {}).filter((n) => n !== PLATFORM_SERVER_NAME)
	const count = servers.length
	const reasons: string[] = []
	const gaps: CapabilityGap[] = []

	let score = countScale(count, [0, 2, 3, 4])
	if (count >= 1 && unresolved.length === 0) score = Math.min(5, score + 1) as CapabilityScore
	if (count > 0) reasons.push(`${count} connector${count === 1 ? '' : 's'} configured`)

	if (unresolved.length > 0) {
		// A configured connector whose token never resolves boots broken at session
		// launch — worse than missing, because it looks connected. Cap hard.
		score = Math.min(score, 2) as CapabilityScore
		for (const p of unresolved) {
			gaps.push({
				action: 'connect_integration',
				detail: `Connector "${p.server}" references \${${p.envKey}} but no active integration provides it — connect the integration or remove the server.`,
				toolHint: 'connect_integration',
			})
		}
	}
	if (count === 0) {
		gaps.push({
			action: 'add_mcp_server',
			detail:
				'No external connectors — the agent can only use the Maskin platform. Add MCP servers or connect integrations for the systems it should reach.',
			toolHint: 'connect_integration',
		})
	}

	return { key: 'connectors', label: CAPABILITY_RUBRIC.connectors.label, score, reasons, gaps }
}

function scoreContext(snapshot: AgentCapabilitySnapshot): CapabilityDimension {
	const reasons: string[] = []
	const gaps: CapabilityGap[] = []
	let points = 0

	if (snapshot.memoryKeys >= 1) {
		points += snapshot.memoryKeys >= 3 ? 3 : 2
		reasons.push('Has working memory')
	} else {
		gaps.push({
			action: 'seed_memory',
			detail: 'Memory is empty — seed it with domain context, key facts, and preferences.',
			toolHint: 'update_actor',
		})
	}
	if (snapshot.description) {
		points += 1
		reasons.push('Has a description')
	} else {
		gaps.push({
			action: 'add_description',
			detail: 'Add a one-line description so humans and routers know what this agent is for.',
			toolHint: 'update_actor',
		})
	}
	if (snapshot.model) {
		points += 1
		reasons.push(`Model pinned (${snapshot.model})`)
	} else {
		gaps.push({
			action: 'set_model',
			detail: 'No model pinned — set llm_config.model so runs are reproducible.',
			toolHint: 'update_actor',
		})
	}
	if (snapshot.llmProvider) points += 1

	const score = Math.min(5, points) as CapabilityScore
	return { key: 'context', label: CAPABILITY_RUBRIC.context.label, score, reasons, gaps }
}

function scoreAutonomy(snapshot: AgentCapabilitySnapshot): CapabilityDimension {
	const reasons: string[] = []
	const gaps: CapabilityGap[] = []

	let score = countScale(snapshot.triggerCount, [0, 3, 4, 5])
	if (snapshot.inLoop && score < 3) score = 3
	if (snapshot.triggerCount > 0) {
		reasons.push(
			`${snapshot.triggerCount} trigger${snapshot.triggerCount === 1 ? '' : 's'} target this agent`,
		)
	}
	if (snapshot.inLoop) reasons.push('Runs as part of a loop')

	if (snapshot.triggerCount === 0 && !snapshot.inLoop) {
		gaps.push({
			action: 'add_trigger',
			detail:
				'Nothing runs this agent automatically — add a cron or event trigger so it works without being asked.',
			toolHint: 'create_trigger',
		})
	}

	return { key: 'autonomy', label: CAPABILITY_RUBRIC.autonomy.label, score, reasons, gaps }
}

/** Map a count onto a score scale; counts beyond the scale get the last entry. */
function countScale(count: number, scale: number[]): CapabilityScore {
	const idx = Math.min(count, scale.length - 1)
	return scale[idx] as CapabilityScore
}

/**
 * Walk every string value in a non-platform MCP server spec (env values, header
 * values, args, urls) and collect `${VAR}` placeholders no runtime env var resolves.
 * This surfaces at read time the gap that otherwise only appears at container launch.
 */
export function findUnresolvedPlaceholders(
	snapshot: AgentCapabilitySnapshot,
): UnresolvedPlaceholder[] {
	const available = new Set(snapshot.availableEnvKeys)
	const out: UnresolvedPlaceholder[] = []
	const seen = new Set<string>()

	for (const [name, spec] of Object.entries(snapshot.mcpServers ?? {})) {
		if (name === PLATFORM_SERVER_NAME) continue
		for (const value of collectStrings(spec)) {
			for (const match of value.matchAll(PLACEHOLDER_RE)) {
				const envKey = match[1]
				if (!envKey) continue
				const dedupe = `${name}:${envKey}`
				if (available.has(envKey) || seen.has(dedupe)) continue
				seen.add(dedupe)
				out.push({ server: name, envKey, placeholder: match[0] })
			}
		}
	}
	return out
}

function collectStrings(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
	return []
}

function pickTopGaps(dimensions: CapabilityDimension[]): CapabilityGap[] {
	return dimensions
		.flatMap((dim) =>
			dim.gaps.map((gap) => ({
				gap,
				impact: CAPABILITY_RUBRIC[dim.key].weight * (5 - dim.score),
			})),
		)
		.sort((a, b) => b.impact - a.impact)
		.slice(0, TOP_GAPS_LIMIT)
		.map((entry) => entry.gap)
}

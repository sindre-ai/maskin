import type { SeedAgent, SeedTrigger } from '@maskin/module-sdk'
import { KNOWLEDGE_CURATOR_PROMPT } from './prompts.js'

// Standard Maskin-only MCP tool bundle for curator agents. Matches the
// configuration used by Insight Curator in the template files.
const maskinOnlyTools = {
	mcpServers: {
		maskin: {
			url: '${MASKIN_API_URL}/mcp',
			type: 'http',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}

/**
 * Agents contributed by the Knowledge extension. Templates that enable the
 * `knowledge` module splice these into their seedAgents array.
 */
export const KNOWLEDGE_SEED_AGENTS: SeedAgent[] = [
	{
		$id: 'knowledge_curator',
		name: 'Knowledge Curator',
		tools: maskinOnlyTools,
		systemPrompt: KNOWLEDGE_CURATOR_PROMPT,
	},
]

/**
 * Triggers contributed by the Knowledge extension. Templates that enable the
 * `knowledge` module splice these into their seedTriggers array.
 */
export const KNOWLEDGE_SEED_TRIGGERS: SeedTrigger[] = [
	{
		name: 'Daily Knowledge Synthesis',
		type: 'cron',
		config: { expression: '0 6 * * *' },
		targetActor$id: 'knowledge_curator',
		enabled: true,
		actionPrompt:
			'Run your daily knowledge synthesis. Insight curation ran an hour ago; fresh clusters and any newly completed bets are ready to mine.\n\n1. list_objects({type: "insight"}) — focus on insights recently moved to "processing" or "clustered". Group by theme.\n2. list_objects({type: "bet"}) — focus on bets with status "completed" or "validated" in the last 14 days. Each is a candidate rule source.\n3. list_objects({type: "knowledge"}) — read existing articles so you don\'t duplicate.\n4. For each durable theme (recurring across 2+ insights) or validated-bet learning, either create a new knowledge object or update an existing one (supersedes + deprecate the old, if you\'re refining it).\n5. Attach "informs" relationships from every source insight/bet to the knowledge article.\n6. Set status "validated" ONLY when you have a completed bet or 3+ corroborating insights; otherwise "draft". Set metadata.confidence accordingly.\n7. Notify the human via a Maskin notification for each new validated article (source_actor_id = {{self_id}}; metadata.actions native JSON array, e.g. [{"label":"Keep","response":"keep"},{"label":"Deprecate","response":"deprecate"}]).\n8. If nothing durable has surfaced, exit silently.',
	},
	{
		name: 'Bet Completed → Knowledge Synthesis',
		type: 'event',
		config: {
			entity_type: 'bet',
			action: 'status_changed',
			to_status: 'completed',
		},
		targetActor$id: 'knowledge_curator',
		enabled: false,
		actionPrompt:
			'A bet just completed. Read it and its "informs" insights. Decide whether the outcome codifies a durable rule worth promoting to knowledge. If yes, create or update a knowledge article (status "validated", confidence "high") with "informs" edges from the bet and its source insights. If the outcome refines an existing article, use "supersedes" and mark the old one "deprecated". If nothing durable emerges, exit silently.',
	},
]

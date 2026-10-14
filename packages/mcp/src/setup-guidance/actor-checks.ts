import { sortByPriority } from './priority'
import type { ActorInput, SetupCheck } from './types'

function safeCheck(name: string, run: () => SetupCheck | null): SetupCheck | null {
	try {
		return run()
	} catch (err) {
		console.error(`[setup-guidance] actor check '${name}' threw, degrading to unknown:`, err)
		return {
			name,
			status: 'unknown',
			message: `Could not evaluate ${name}: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

const MIN_SYSTEM_PROMPT_LENGTH = 200

function systemPromptQuality(actor: ActorInput): SetupCheck | null {
	const prompt = actor.systemPrompt?.trim() ?? ''
	if (prompt.length >= MIN_SYSTEM_PROMPT_LENGTH) return null
	return {
		name: 'system_prompt_quality',
		status: 'warn',
		message:
			prompt.length === 0
				? 'This agent has no system prompt yet — add one so it knows its role and how to behave.'
				: `This agent's system prompt is only ${prompt.length} character${prompt.length === 1 ? '' : 's'} — add a fuller system prompt (aim for ${MIN_SYSTEM_PROMPT_LENGTH}+).`,
		fix: {
			tool: 'update_actor',
			args_hint: 'set system_prompt: "<a fuller description of role, scope, and behavior>"',
			why: 'A thin system prompt leaves the agent guessing at its role and constraints.',
		},
	}
}

function skillsAttached(actor: ActorInput): SetupCheck | null {
	const count = actor.skillCount ?? 0
	if (count === 0) {
		return {
			name: 'skills_attached',
			status: 'warn',
			message: 'This agent has no skills attached — consider attaching a relevant skill.',
			fix: {
				tool: 'update_actor',
				args_hint: 'attach_skill_ids: ["<workspace skill id>"] (see list_workspace_skills)',
				why: 'Skills are what make an agent expert-level rather than just a well-written prompt.',
			},
		}
	}
	if (count === 1) {
		return {
			name: 'skills_attached',
			status: 'warn',
			message: 'This agent has only one skill attached — consider attaching more skills.',
			fix: {
				tool: 'update_actor',
				args_hint: 'attach_skill_ids: ["<workspace skill id>"] (see list_workspace_skills)',
				why: 'Most capable agents draw on more than one skill for their domain.',
			},
		}
	}
	return null
}

function mcpConfigured(actor: ActorInput): SetupCheck | null {
	const count = actor.nonMaskinMcpServerCount ?? 0
	if (count === 0) {
		return {
			name: 'mcp_configured',
			status: 'warn',
			message:
				'This agent has no MCP tools beyond the built-in Maskin connection — consider adding one so it can take action outside Maskin.',
			fix: {
				tool: 'update_actor',
				args_hint: 'set tools.mcpServers.<name> to a new MCP server config',
				why: 'Without external tools, this agent can only read and write Maskin objects — most agents need to act on other systems too.',
			},
		}
	}
	if (count === 1) {
		return {
			name: 'mcp_configured',
			status: 'warn',
			message: 'This agent has one MCP tool configured — consider adding another.',
			fix: {
				tool: 'update_actor',
				args_hint: 'set tools.mcpServers.<name> to a new MCP server config',
				why: 'Agents that touch multiple systems (e.g. GitHub + Slack) usually need more than one tool.',
			},
		}
	}
	return null
}

function automationWired(actor: ActorInput): SetupCheck | null {
	if (actor.wiredToAutomation) return null
	return {
		name: 'automation_wired',
		status: 'warn',
		message:
			"This agent isn't wired into any trigger or loop yet, so nothing will make it run on its own — consider adding it to a trigger or loop.",
		fix: {
			tool: 'create_trigger',
			args_hint: `target_actor_id: "${actor.id}" + a cron/event/reminder config (or add a step targeting this actor via create_loop/update_loop)`,
			why: 'Without a trigger or loop, this agent only ever runs when explicitly invoked via create_session.',
		},
	}
}

/** Checks apply only to `type: 'agent'` actors — human actors don't have a system prompt, skills, or tools to configure. */
export function checkActor(actor: ActorInput): SetupCheck[] {
	if (actor.type !== 'agent') return []
	const results: (SetupCheck | null)[] = [
		safeCheck('system_prompt_quality', () => systemPromptQuality(actor)),
		safeCheck('skills_attached', () => skillsAttached(actor)),
		safeCheck('mcp_configured', () => mcpConfigured(actor)),
		safeCheck('automation_wired', () => automationWired(actor)),
	]
	return sortByPriority(results.filter((c): c is SetupCheck => c !== null))
}

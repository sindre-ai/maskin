import type { Database } from '@maskin/db'
import { actors, agentSkills, messages, workspaceSkills } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { desc, eq } from 'drizzle-orm'
import type { StreamMessage } from '../lib/llm/openai-stream'
import { logger } from '../lib/logger'
import { renderWorkspaceBriefing } from './workspace-briefing'

/**
 * Assembles what the model sees on a live turn. It mirrors the order a
 * container session builds CLAUDE.md in (agent-run.sh): who you are, your
 * skills, the workspace snapshot, what you have learned, plus a style block that
 * is specific to being heard rather than read.
 */

export const HISTORY_MESSAGES = 15
const BRIEFING_MAX_CHARS = 12_000
const LEARNINGS_MAX_CHARS = 6_000
const SKILLS_MAX_CHARS = 20_000

export const LIVE_PREAMBLE = [
	'You are in a live voice conversation. Whatever you write is spoken aloud to the person immediately, in your own voice, and they can interrupt you at any time.',
	'You have the same tools you have in chat. Use them when they help, and answer in words afterwards.',
].join('\n')

export const LIVE_STYLE = [
	'## How to speak',
	'- Talk the way a thoughtful colleague talks. One to three short sentences unless the person asks for more.',
	'- No markdown, headings, bullet lists, tables, code or URLs. Say lists as a sentence ("three things: first, second, and third").',
	'- Say names and titles, never ids. Say numbers the way you would say them out loud.',
	'- If you need to look something up, you may say so in a few words, then do it. Do not narrate tool calls or write them out as text.',
	'- Before anything that changes data, ask one short yes or no question and wait. Reading and looking up never needs permission.',
	'- If you are not sure what you heard, ask back instead of guessing. Names and numbers are the easiest to mishear.',
	'- If something is long or visual, say the headline and offer to put the detail in the chat.',
].join('\n')

export interface SkillText {
	name: string
	content: string
}

export interface PulledUpObject {
	id: string
	type: string
	title: string
	status: string | null
	excerpt: string
}

export interface LivePromptParts {
	agentName: string
	humanName: string
	systemPrompt: string | null
	skills: SkillText[]
	briefing: string | null
	learnings: string | null
	/** Other people and agents in the conversation, by name. */
	otherParticipants: string[]
	/** Objects the person pulled up on screen since the last turn. */
	pulledUp: PulledUpObject[]
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[…trimmed]` : text
}

export function composeLiveSystemPrompt(p: LivePromptParts): string {
	const sections: string[] = [
		LIVE_PREAMBLE,
		p.systemPrompt?.trim() || 'You are a helpful AI agent.',
	]

	if (p.skills.length > 0) {
		const body = p.skills.map((s) => `### ${s.name}\n${s.content.trim()}`).join('\n\n')
		sections.push(`## Skills\n${clip(body, SKILLS_MAX_CHARS)}`)
	}
	if (p.briefing?.trim()) {
		sections.push(`## Workspace snapshot\n${clip(p.briefing.trim(), BRIEFING_MAX_CHARS)}`)
	}
	if (p.learnings?.trim()) {
		sections.push(`## What you have learned\n${clip(p.learnings.trim(), LEARNINGS_MAX_CHARS)}`)
	}

	const who = [`- ${p.humanName} is the person you are speaking with.`, `- You are ${p.agentName}.`]
	for (const name of p.otherParticipants) who.push(`- ${name} is also in this conversation.`)
	sections.push(`## Who is here\n${who.join('\n')}`)

	if (p.pulledUp.length > 0) {
		const items = p.pulledUp.map(
			(o) => `- ${o.title} (${o.type}${o.status ? `, ${o.status}` : ''}): ${o.excerpt}`,
		)
		sections.push(`## On their screen right now\n${items.join('\n')}`)
	}

	sections.push(LIVE_STYLE)
	return sections.join('\n\n')
}

export interface HistoryRow {
	actorId: string
	actorName: string
	content: string
	metadata: unknown
}

/**
 * Turns stored messages into chat roles. An interrupted agent line keeps only
 * what was spoken in `content`; the model should know what it was about to say,
 * so prefer the full text the live turn stored beside it.
 */
export function toHistoryMessages(rows: HistoryRow[], agentId: string): StreamMessage[] {
	return rows.map((r) => {
		if (r.actorId === agentId) {
			const live = (r.metadata as { live?: { full_text?: unknown; interrupted?: unknown } } | null)
				?.live
			const full =
				typeof live?.full_text === 'string' && live.interrupted === true ? live.full_text : null
			return {
				role: 'assistant' as const,
				content: full
					? `${r.content} [interrupted; you had been going to say: ${full}]`
					: r.content,
			}
		}
		return { role: 'user' as const, content: `${r.actorName}: ${r.content}` }
	})
}

export interface BuildLiveContextArgs {
	db: Database
	storage: StorageProvider
	workspaceId: string
	agent: { id: string; name: string; systemPrompt: string | null }
	human: { id: string; name: string }
	conversationId: string | null
	pulledUp?: PulledUpObject[]
	otherParticipants?: string[]
}

async function loadSkills(db: Database, agentId: string): Promise<SkillText[]> {
	return db
		.select({ name: workspaceSkills.name, content: workspaceSkills.content })
		.from(agentSkills)
		.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
		.where(eq(agentSkills.actorId, agentId))
		.orderBy(workspaceSkills.name)
}

async function loadLearnings(
	storage: StorageProvider,
	workspaceId: string,
	agentId: string,
): Promise<string | null> {
	const key = `agents/${workspaceId}/${agentId}/memory/consolidated-learnings.md`
	try {
		if (!(await storage.exists(key))) return null
		return (await storage.get(key)).toString('utf8')
	} catch (err) {
		logger.warn('live prompt: learnings unavailable', {
			agent_id: agentId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

async function loadBriefing(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
): Promise<string | null> {
	try {
		return await renderWorkspaceBriefing(db, storage, workspaceId)
	} catch (err) {
		// A missing snapshot degrades the answer; it must not drop the call.
		logger.warn('live prompt: briefing unavailable', {
			workspace_id: workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/** Loads everything a turn needs. The system prompt is rebuilt per turn so skill and memory edits apply immediately. */
export async function buildLiveContext(
	a: BuildLiveContextArgs,
): Promise<{ system: string; history: StreamMessage[] }> {
	const [skills, briefing, learnings, historyRows] = await Promise.all([
		loadSkills(a.db, a.agent.id),
		loadBriefing(a.db, a.storage, a.workspaceId),
		loadLearnings(a.storage, a.workspaceId, a.agent.id),
		a.conversationId
			? a.db
					.select({
						actorId: messages.actorId,
						actorName: actors.name,
						content: messages.content,
						metadata: messages.metadata,
					})
					.from(messages)
					.innerJoin(actors, eq(actors.id, messages.actorId))
					.where(eq(messages.conversationId, a.conversationId))
					.orderBy(desc(messages.id))
					.limit(HISTORY_MESSAGES)
			: Promise.resolve([] as HistoryRow[]),
	])
	return {
		system: composeLiveSystemPrompt({
			agentName: a.agent.name,
			humanName: a.human.name,
			systemPrompt: a.agent.systemPrompt,
			skills,
			briefing,
			learnings,
			otherParticipants: a.otherParticipants ?? [],
			pulledUp: a.pulledUp ?? [],
		}),
		history: toHistoryMessages(historyRows.slice().reverse(), a.agent.id),
	}
}

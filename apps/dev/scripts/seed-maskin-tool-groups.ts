// Seed which groups of Maskin's own tools each agent keeps (see packages/mcp tool-groups.ts).
//
// An agent keeps every group it used in the window (the Maskin tool names in its session logs)
// and every group whose tools are named in its prompt, its skills, its triggers' prompts or the
// loops it is part of, so a tool a scheduled run needs is kept even when the window did not see
// it. The result is written to the agent's tools config as maskin_tool_groups. Agents that
// already have the list are left alone, so a re-run changes nothing, and nothing is read or
// written unless MASKIN_TOOL_GROUPS is switched on later: the list alone changes no session.
//
// Dry run by default: prints, per agent, the groups it would keep and the ones it would lose.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-maskin-tool-groups.ts
//   ... --apply                  write the lists
//   ... --days=30 --workspace=<uuid>

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { actors, agentSkills, sessions, triggers, workspaceSkills } from '@maskin/db/schema'
import {
	TOOL_GROUP_NAMES,
	type ToolGroup,
	groupedToolNamesIn,
	groupsForToolNames,
} from '@maskin/mcp'
import { and, eq, sql } from 'drizzle-orm'

export type SeedOptions = { apply: boolean; days: number; workspaceId?: string }

export type SeedRow = {
	actorId: string
	name: string
	keeps: ToolGroup[]
	loses: ToolGroup[]
	written: boolean
}

export async function seedMaskinToolGroups(db: Database, opts: SeedOptions): Promise<SeedRow[]> {
	const agents = await db
		.select({
			id: actors.id,
			name: actors.name,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
		})
		.from(actors)
		.where(eq(actors.type, 'agent'))

	// Tool names called in the window, per agent: one scan of the logs, names only.
	const used = await db.execute<{ actor_id: string; tool: string }>(sql`
		select distinct s.actor_id, m[1] as tool
		from session_logs l
		join sessions s on s.id = l.session_id
		cross join lateral regexp_matches(l.content, 'mcp__maskin__([a-z_]+)', 'g') as m
		where l.created_at > now() - make_interval(days => ${opts.days})
		${opts.workspaceId ? sql`and s.workspace_id = ${opts.workspaceId}` : sql``}
	`)
	const usedBy = new Map<string, Set<string>>()
	for (const row of used) {
		const set = usedBy.get(row.actor_id) ?? new Set<string>()
		set.add(row.tool)
		usedBy.set(row.actor_id, set)
	}

	const rows: SeedRow[] = []
	for (const agent of agents) {
		const current = (agent.tools ?? {}) as Record<string, unknown>
		if (Array.isArray(current.maskin_tool_groups)) continue

		const texts: string[] = [agent.systemPrompt ?? '']
		const skillRows = await db
			.select({ content: workspaceSkills.content })
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
			.where(eq(agentSkills.actorId, agent.id))
		texts.push(...skillRows.map((r) => r.content))
		const triggerRows = await db
			.select({ prompt: triggers.actionPrompt, config: triggers.config })
			.from(triggers)
			.where(eq(triggers.targetActorId, agent.id))
		texts.push(...triggerRows.map((r) => `${r.prompt} ${JSON.stringify(r.config)}`))

		const named = texts.flatMap((t) => groupedToolNamesIn(t))
		const keeps = groupsForToolNames([...(usedBy.get(agent.id) ?? []), ...named])
		const loses = TOOL_GROUP_NAMES.filter((g) => !keeps.includes(g))

		let written = false
		if (opts.apply) {
			// Re-checks that the list is still absent, so a racing writer is not overwritten.
			const updated = await db
				.update(actors)
				.set({
					tools: { ...current, mcpServers: current.mcpServers ?? {}, maskin_tool_groups: keeps },
				})
				.where(
					and(
						eq(actors.id, agent.id),
						sql`not (coalesce(${actors.tools}, '{}'::jsonb) ? 'maskin_tool_groups')`,
					),
				)
				.returning({ id: actors.id })
			written = updated.length > 0
		}
		rows.push({ actorId: agent.id, name: agent.name, keeps, loses, written })
	}
	return rows
}

function parseArgs(argv: string[]): SeedOptions {
	const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
	const days = Number(flag('days') ?? 30)
	if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number')
	return { apply: argv.includes('--apply'), days, workspaceId: flag('workspace') }
}

export async function main() {
	const databaseUrl = process.env.DATABASE_URL
	if (!databaseUrl) {
		console.error('DATABASE_URL is required.')
		process.exit(1)
	}
	const opts = parseArgs(process.argv.slice(2))
	const rows = await seedMaskinToolGroups(createDb(databaseUrl), opts)
	console.log(opts.apply ? 'APPLIED' : 'DRY RUN (nothing written, pass --apply to write)')
	for (const r of rows) {
		console.log(
			`${r.name} (${r.actorId}) keeps [${r.keeps.join(', ')}] loses [${r.loses.join(', ')}]${r.written ? ' written' : ''}`,
		)
	}
	console.log(`${rows.length} agents without a list`)
	process.exit(0)
}

const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}

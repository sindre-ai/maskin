import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { objects } from '@maskin/db/schema'
import type { SessionBootHookParams } from '@maskin/module-sdk'
import { and, desc, eq } from 'drizzle-orm'

const MAX_TOTAL_BYTES = 20_000
const MAX_ARTICLE_BYTES = 4_000

/**
 * Session-boot hook for the Knowledge extension.
 *
 * Reads every validated knowledge article in the workspace and writes each as
 * a markdown file into `${tempDir}/knowledge/`. The container's `agent-run.sh`
 * script then appends these files under a "Workspace knowledge" section in
 * `CLAUDE.md`, so every agent boots with the workspace's standing rules in
 * context — no dependency on the agent remembering to search.
 *
 * Budget: ~20KB total / ~4KB per article. Over budget falls back to summaries.
 */
export async function knowledgeSessionBootHook({
	db,
	workspaceId,
	tempDir,
}: SessionBootHookParams): Promise<void> {
	try {
		const articles = await db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'knowledge'),
					eq(objects.status, 'validated'),
				),
			)
			.orderBy(desc(objects.updatedAt))

		if (articles.length === 0) return

		const knowledgeDir = join(tempDir, 'knowledge')
		await mkdir(knowledgeDir, { recursive: true })
		await chmod(knowledgeDir, 0o777)

		let totalBytes = 0

		for (const article of articles) {
			if (totalBytes >= MAX_TOTAL_BYTES) break

			const metadata = (article.metadata as Record<string, unknown> | null) ?? {}
			const summary = typeof metadata.summary === 'string' ? metadata.summary : ''
			const title = article.title?.trim() || 'Untitled'
			const full = article.content?.trim() ?? ''
			const bodyFull = summary ? `${summary}\n\n${full}`.trim() : full
			const remaining = MAX_TOTAL_BYTES - totalBytes
			const bodyBudget = Math.min(MAX_ARTICLE_BYTES, remaining)
			const body =
				Buffer.byteLength(bodyFull, 'utf8') <= bodyBudget
					? bodyFull
					: summary || `${bodyFull.slice(0, bodyBudget - 200)}…`

			const file = `## ${title}\n\n${body}\n\n[maskin://objects/${article.id}]\n`
			const bytes = Buffer.byteLength(file, 'utf8')
			if (bytes > bodyBudget) continue

			await writeFile(join(knowledgeDir, `${article.id}.md`), file)
			totalBytes += bytes
		}
	} catch {
		// Never block a session on a knowledge read failure. The session manager
		// treats hook failures as non-fatal; we swallow here so even a thrown
		// error inside the loop doesn't reach the manager.
	}
}

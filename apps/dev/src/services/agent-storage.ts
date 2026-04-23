import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@maskin/db'
import { agentFiles } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, isNull } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { appendToLedger } from './workspace-briefing'

/** S3 prefix for workspace-scoped files (team skills, etc.). */
function workspacePrefix(workspaceId: string): string {
	return `workspaces/${workspaceId}/`
}

/** S3 key for a workspace-scoped file. */
function workspaceKey(workspaceId: string, fileType: string, path: string): string {
	return `${workspacePrefix(workspaceId)}${fileType}/${path}`
}

export class AgentStorageManager {
	constructor(
		private storage: StorageProvider,
		private db: Database,
	) {}

	/**
	 * Pull all agent files from S3 into a local directory.
	 * Creates the directory structure: /agent/{skills,learnings,memory}
	 *
	 * Pulls in two passes so that personal files override workspace-shared ones
	 * on name collision (e.g. `skills/foo/SKILL.md`):
	 *   1. workspace-scoped files under `workspaces/{workspaceId}/` (team skills)
	 *   2. actor-scoped files under `agents/{workspaceId}/{actorId}/` (personal)
	 */
	async pullAgentFiles(actorId: string, workspaceId: string, localDir: string): Promise<void> {
		let total = 0

		// Pass 1: workspace-shared files (team skills, etc.)
		const wsPrefix = workspacePrefix(workspaceId)
		const wsKeys = await this.storage.list(wsPrefix)
		for (const key of wsKeys) {
			const relativePath = key.slice(wsPrefix.length)
			const localPath = join(localDir, relativePath)
			await mkdir(join(localPath, '..'), { recursive: true })
			const data = await this.storage.get(key)
			await writeFile(localPath, data)
			total++
		}

		// Pass 2: personal files — written second so same-named files win.
		const prefix = `agents/${workspaceId}/${actorId}/`
		const keys = await this.storage.list(prefix)
		for (const key of keys) {
			const relativePath = key.slice(prefix.length)
			const localPath = join(localDir, relativePath)
			await mkdir(join(localPath, '..'), { recursive: true })
			const data = await this.storage.get(key)
			await writeFile(localPath, data)
			total++
		}

		// Ensure directory structure exists even if empty
		await mkdir(join(localDir, 'skills'), { recursive: true })
		await mkdir(join(localDir, 'learnings'), { recursive: true })
		await mkdir(join(localDir, 'memory'), { recursive: true })
		await mkdir(join(localDir, 'workspace'), { recursive: true })

		logger.info(`Pulled ${total} agent files`, {
			actorId,
			workspaceId,
			personal: keys.length,
			shared: wsKeys.length,
		})
	}

	/**
	 * Push new/changed files back to S3 after a session completes.
	 * Pushes the per-session learning file, any memory updates, and appends a
	 * one-line entry to the workspace-scoped learnings ledger so future sessions
	 * in this workspace can see what was tried.
	 */
	async pushAgentFiles(
		actorId: string,
		workspaceId: string,
		sessionId: string,
		localDir: string,
		opts?: { actionPrompt?: string },
	): Promise<void> {
		let pushed = 0

		// Push per-session learning file if it exists
		const learningsDir = join(localDir, 'learnings')
		const learningFile = `session-${sessionId}.md`
		const learningPath = join(learningsDir, learningFile)

		try {
			const data = await readFile(learningPath)
			const relativePath = `learnings/${learningFile}`
			const key = `agents/${workspaceId}/${actorId}/${relativePath}`
			await this.storage.put(key, data)
			await this.upsertFileRecord(
				actorId,
				workspaceId,
				'learning',
				relativePath,
				key,
				data.length,
				sessionId,
			)
			pushed++
		} catch {
			// No learning file produced — that's fine
		}

		// Push memory files (CLAUDE.md, consolidated-learnings.md, etc.)
		const memoryDir = join(localDir, 'memory')
		try {
			const files = await readdir(memoryDir)
			for (const file of files) {
				const filePath = join(memoryDir, file)
				const data = await readFile(filePath)
				const relativePath = `memory/${file}`
				const key = `agents/${workspaceId}/${actorId}/${relativePath}`
				await this.storage.put(key, data)
				await this.upsertFileRecord(
					actorId,
					workspaceId,
					'memory',
					relativePath,
					key,
					data.length,
					sessionId,
				)
				pushed++
			}
		} catch {
			// No memory dir or empty
		}

		await this.appendWorkspaceLedger(workspaceId, sessionId, localDir, opts?.actionPrompt)

		logger.info(`Pushed ${pushed} files to storage`, { actorId, workspaceId, sessionId })
	}

	/**
	 * Append a one-line summary of this session to the workspace ledger so every
	 * future session's briefing can surface what was tried across the whole
	 * workspace. Prefers SESSION_LEARNING.md first line, falls back to the
	 * action prompt. Silent on failure — ledger is best-effort.
	 */
	private async appendWorkspaceLedger(
		workspaceId: string,
		sessionId: string,
		localDir: string,
		actionPromptFallback?: string,
	): Promise<void> {
		let summary = ''
		try {
			const buf = await readFile(join(localDir, 'workspace', 'SESSION_LEARNING.md'))
			const firstLine = buf
				.toString('utf-8')
				.split('\n')
				.find((l) => l.trim().length > 0)
			if (firstLine) summary = firstLine.trim()
		} catch {
			// File absent — fall through
		}

		if (!summary && actionPromptFallback) {
			summary = actionPromptFallback.trim().split('\n')[0] ?? ''
		}
		if (!summary) summary = '(no learning recorded)'

		const maxSummary = 200
		if (summary.length > maxSummary) summary = `${summary.slice(0, maxSummary - 1)}…`

		const timestamp = new Date().toISOString()
		const line = `${timestamp} · session ${sessionId.slice(0, 8)} · ${summary}`
		try {
			await appendToLedger(this.storage, workspaceId, line)
		} catch (err) {
			logger.warn('Failed to append to workspace ledger', {
				workspaceId,
				sessionId,
				error: String(err),
			})
		}
	}

	/**
	 * Get a single file's content from S3.
	 */
	async getFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
	): Promise<Buffer> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		return this.storage.get(key)
	}

	/**
	 * List file records from DB (metadata: id, path, sizeBytes, updatedAt).
	 */
	async listFileRecords(actorId: string, workspaceId: string, fileType?: string) {
		const conditions = [eq(agentFiles.actorId, actorId), eq(agentFiles.workspaceId, workspaceId)]
		if (fileType) conditions.push(eq(agentFiles.fileType, fileType))
		return this.db
			.select()
			.from(agentFiles)
			.where(and(...conditions))
	}

	/**
	 * Upload a single file (skill, config, etc.) to agent storage.
	 */
	async uploadFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
		content: Buffer,
	): Promise<string> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		await this.storage.put(key, content)
		await this.upsertFileRecord(actorId, workspaceId, fileType, relativePath, key, content.length)
		return key
	}

	/**
	 * List files for an agent, optionally filtered by type.
	 */
	async listFiles(actorId: string, workspaceId: string, fileType?: string): Promise<string[]> {
		const prefix = fileType
			? `agents/${workspaceId}/${actorId}/${fileType}/`
			: `agents/${workspaceId}/${actorId}/`
		return this.storage.list(prefix)
	}

	/**
	 * Delete a file from agent storage.
	 */
	async deleteFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
	): Promise<void> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		await this.storage.delete(key)

		await this.db
			.delete(agentFiles)
			.where(
				and(
					eq(agentFiles.actorId, actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, relativePath),
				),
			)
	}

	private async upsertFileRecord(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
		storageKey: string,
		sizeBytes: number,
		sessionId?: string,
	): Promise<void> {
		// Try update first, insert if not exists
		const updated = await this.db
			.update(agentFiles)
			.set({ storageKey, sizeBytes, sessionId, updatedAt: new Date() })
			.where(
				and(
					eq(agentFiles.actorId, actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, path),
				),
			)
			.returning()

		if (updated.length === 0) {
			await this.db.insert(agentFiles).values({
				actorId,
				workspaceId,
				fileType,
				path,
				storageKey,
				sizeBytes,
				sessionId,
			})
		}
	}

	// ── Workspace-scoped files (team skills, etc.) ────────────────────────────

	/**
	 * Get a workspace-scoped file's content from S3.
	 */
	async getWorkspaceFile(workspaceId: string, fileType: string, path: string): Promise<Buffer> {
		return this.storage.get(workspaceKey(workspaceId, fileType, path))
	}

	/**
	 * List workspace-scoped file records from DB (actor_id IS NULL).
	 */
	async listWorkspaceFileRecords(workspaceId: string, fileType?: string) {
		const conditions = [eq(agentFiles.workspaceId, workspaceId), isNull(agentFiles.actorId)]
		if (fileType) conditions.push(eq(agentFiles.fileType, fileType))
		return this.db
			.select()
			.from(agentFiles)
			.where(and(...conditions))
	}

	/**
	 * Upload a workspace-scoped file (team skill, etc.) to storage.
	 */
	async uploadWorkspaceFile(
		workspaceId: string,
		fileType: string,
		path: string,
		content: Buffer,
	): Promise<string> {
		const relativePath = `${fileType}/${path}`
		const key = workspaceKey(workspaceId, fileType, path)
		await this.storage.put(key, content)
		await this.upsertWorkspaceFileRecord(workspaceId, fileType, relativePath, key, content.length)
		return key
	}

	/**
	 * Delete a workspace-scoped file from storage.
	 */
	async deleteWorkspaceFile(workspaceId: string, fileType: string, path: string): Promise<void> {
		const relativePath = `${fileType}/${path}`
		const key = workspaceKey(workspaceId, fileType, path)
		await this.storage.delete(key)

		await this.db
			.delete(agentFiles)
			.where(
				and(
					isNull(agentFiles.actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, relativePath),
				),
			)
	}

	private async upsertWorkspaceFileRecord(
		workspaceId: string,
		fileType: string,
		path: string,
		storageKey: string,
		sizeBytes: number,
	): Promise<void> {
		const updated = await this.db
			.update(agentFiles)
			.set({ storageKey, sizeBytes, updatedAt: new Date() })
			.where(
				and(
					isNull(agentFiles.actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, path),
				),
			)
			.returning()

		if (updated.length === 0) {
			await this.db.insert(agentFiles).values({
				actorId: null,
				workspaceId,
				fileType,
				path,
				storageKey,
				sizeBytes,
			})
		}
	}
}

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@maskin/db'
import { agentFiles } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'

export class AgentStorageManager {
	constructor(
		private storage: StorageProvider,
		private db: Database,
	) {}

	/**
	 * Pull all agent files from S3 into a local directory.
	 * Creates the directory structure: /agent/{skills,learnings,memory}
	 */
	async pullAgentFiles(actorId: string, workspaceId: string, localDir: string): Promise<void> {
		const prefix = `agents/${workspaceId}/${actorId}/`
		const keys = await this.storage.list(prefix)

		for (const key of keys) {
			const relativePath = key.slice(prefix.length)
			const localPath = join(localDir, relativePath)

			// Ensure parent directory exists
			const parentDir = join(localPath, '..')
			await mkdir(parentDir, { recursive: true })

			const data = await this.storage.get(key)
			await writeFile(localPath, data)
		}

		// Ensure directory structure exists even if empty
		await mkdir(join(localDir, 'skills'), { recursive: true })
		await mkdir(join(localDir, 'learnings'), { recursive: true })
		await mkdir(join(localDir, 'memory'), { recursive: true })
		await mkdir(join(localDir, 'workspace'), { recursive: true })

		logger.info(`Pulled ${keys.length} agent files`, { actorId, workspaceId })
	}

	/**
	 * Push new/changed files back to S3 after a session completes.
	 * Only pushes learnings (per-session file) and memory updates.
	 */
	async pushAgentFiles(
		actorId: string,
		workspaceId: string,
		sessionId: string,
		localDir: string,
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

		logger.info(`Pushed ${pushed} files to storage`, { actorId, workspaceId, sessionId })
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
}

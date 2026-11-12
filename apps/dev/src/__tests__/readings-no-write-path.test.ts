import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app-factory'
import { expectedByNow } from '../lib/readings'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * A reading is a number an agent cannot write. These checks fail if a way for an agent to add
 * or edit one appears: a route, an MCP tool, or another place in the server that writes the
 * table. Server code writes it only through lib/readings.ts.
 */

const devSrc = new URL('..', import.meta.url).pathname
const mcpSrc = new URL('../../../../packages/mcp/src/', import.meta.url).pathname

function sourceFiles(dir: string, skip: (path: string) => boolean): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (skip(path)) continue
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path, skip))
		else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
	}
	return out
}

describe('readings have no agent write path', () => {
	it('has no route that mentions readings, so a call to add or edit one finds nothing', () => {
		const deps: AppDeps = {
			db: {} as unknown as Database,
			notifyBridge: {} as unknown as PgNotifyBridge,
			sessionManager: {} as unknown as SessionManager,
			agentStorage: {} as unknown as AgentStorageManager,
			storageProvider: {} as unknown as StorageProvider,
		}
		const app = createApp(deps, { includeExtensions: true })
		const routes = app.routes
			.filter((r) => /reading/i.test(r.path))
			.map((r) => `${r.method} ${r.path}`)
		expect(routes).toEqual([])
	})

	it('has no MCP tool that touches readings', () => {
		const hits = sourceFiles(mcpSrc, (p) => p.includes('__tests__'))
			.filter((f) => /\breadings?\b/i.test(readFileSync(f, 'utf8')))
			.map((f) => relative(mcpSrc, f))
		expect(hits).toEqual([])
	})

	it('writes the readings table only from lib/readings.ts', () => {
		const writers = sourceFiles(devSrc, (p) => p.includes('__tests__'))
			.filter((f) => /\.(insert|update|delete)\(\s*readings\s*\)/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(devSrc, f))
		expect(writers).toEqual(['lib/readings.ts'])
	})
})

describe('expectedByNow', () => {
	const start = new Date('2026-11-01T00:00:00Z')
	const deadline = new Date('2026-11-11T00:00:00Z')

	it('is a straight line from the start to the deadline', () => {
		expect(
			expectedByNow({ start, deadline, goal: 100, now: new Date('2026-11-06T00:00:00Z') }),
		).toBe(50)
	})

	it('stays at 0 before the start and at the goal after the deadline', () => {
		expect(
			expectedByNow({ start, deadline, goal: 100, now: new Date('2026-10-01T00:00:00Z') }),
		).toBe(0)
		expect(
			expectedByNow({ start, deadline, goal: 100, now: new Date('2026-12-01T00:00:00Z') }),
		).toBe(100)
	})

	it('is null without a deadline or when the deadline is not after the start', () => {
		expect(expectedByNow({ start, deadline: null, goal: 100, now: start })).toBeNull()
		expect(expectedByNow({ start, deadline: start, goal: 100, now: start })).toBeNull()
	})
})

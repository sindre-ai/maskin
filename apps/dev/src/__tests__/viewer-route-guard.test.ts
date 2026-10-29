import fs from 'node:fs'
import path from 'node:path'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import { auditWriteRoutes, listWriteRoutes } from './viewer-route-policy'

/**
 * Viewers are read-only, so every write route has to be gated. This test needs
 * no database: it builds the app the way app-factory-mcp-probe.test.ts does and
 * reads the route table, so a new write route that nobody classified fails here.
 * It proves each route is accounted for, not that its handler calls the check.
 * That stays with the viewer 403 tests (integration/viewer-read-only.test.ts).
 * The lists live in viewer-route-policy.ts.
 */

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched while building the route table')
		},
	},
) as unknown as Database

function buildApp() {
	const deps: AppDeps = {
		db: forbiddenDb,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

const audit = auditWriteRoutes(listWriteRoutes(buildApp()))

describe('viewer read-only route table', () => {
	it('accounts for every write route: tagged writer, hand-gated, or open', () => {
		expect(audit.unaccounted).toEqual([])
	})

	it("only uses 'writer' as the x-viewer-policy value", () => {
		expect(audit.badTag).toEqual([])
	})

	it('keeps a tagged route off the open list', () => {
		expect(audit.taggedAndOpen).toEqual([])
	})

	it('keeps a hand-gated route untagged and off the open list', () => {
		expect(audit.taggedAndHandGated).toEqual([])
		expect(audit.handGatedAndOpen).toEqual([])
	})

	it('has no open or hand-gated entry for a route that does not exist', () => {
		expect(audit.staleEntries).toEqual([])
	})

	it('keeps POST /mcp open only while the MCP package has no database access', () => {
		const srcDir = path.resolve(import.meta.dirname, '../../../../packages/mcp/src')
		const files = fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
		const withDb = files
			.filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
			.filter((f) => fs.readFileSync(path.join(srcDir, f), 'utf8').includes('@maskin/db'))
		expect(withDb).toEqual([])
	})

	it('prints how the write routes are accounted for', () => {
		console.info(
			`Write routes: ${audit.taggedCount} writer-gated, ${audit.handGatedCount} hand-gated, ${audit.openCount} open`,
		)
	})
})

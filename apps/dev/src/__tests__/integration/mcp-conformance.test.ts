import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
// The matrix lives with the MCP package; this file drives it from the
// integration config against the real app.
import { ROWS } from '../../../../../packages/mcp/src/__tests__/conformance/rows'
import {
	applicability,
	detectFeatures,
	runRow,
} from '../../../../../packages/mcp/src/__tests__/conformance/runner'
import { type AppDeps, createApp } from '../../app-factory'
import type { AgentStorageManager } from '../../services/agent-storage'
import type { SessionManager } from '../../services/session-manager'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Real app (createApp with the real /mcp route) on a real HTTP port with a real
// database. The route writes to the Node response directly, so app.request()
// cannot reach it: it needs a socket.

// Integration tests insert this actor in global-setup.
const TEST_API_KEY = 'ank_testintegration'
const WEB_APP_ORIGIN = 'https://maskin.io'

// A cap this low makes the oversize-response row trip on a handful of rows.
const LOWERED_RESPONSE_CAP = 300

// A row whose server feature has not landed yet is "pending". CI sets
// MCP_CONFORMANCE_STRICT=1 on the bet -> main PR, where pending is a failure, so
// a feature that never lands cannot hide behind a green run.
const strict = process.env.MCP_CONFORMANCE_STRICT === '1'

describe('MCP conformance matrix', () => {
	let server: ReturnType<typeof serve>
	let target: {
		baseUrl: string
		apiKey: string
		workspaceId: string
		webAppOrigin: string
	}
	let features: Awaited<ReturnType<typeof detectFeatures>>

	const env = {
		flag: 'on' as const,
		strict,
		responseCapTokens: LOWERED_RESPONSE_CAP,
	}

	beforeAll(async () => {
		// Read per request by the route and the response cap, so setting them
		// after the app is built is enough. Restored in afterAll: the integration
		// config runs every file in one process.
		vi.stubEnv('MASKIN_MCP_MODERN', 'on')
		vi.stubEnv('MCP_RESPONSE_MAX_TOKENS', String(LOWERED_RESPONSE_CAP))

		const deps: AppDeps = {
			db,
			notifyBridge: {} as unknown as PgNotifyBridge,
			sessionManager: {
				stopSession: async () => {},
				createSession: async () => ({}),
			} as unknown as SessionManager,
			agentStorage: {} as unknown as AgentStorageManager,
			storageProvider: {} as unknown as StorageProvider,
		}
		const app = createApp(deps)
		server = await new Promise<ReturnType<typeof serve>>((resolve) => {
			const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
		})
		const { port } = server.address() as AddressInfo
		// The /mcp route calls the API back on localhost:$PORT.
		vi.stubEnv('PORT', String(port))

		const workspace = await insertWorkspace(db, getTestActorId())
		target = {
			baseUrl: `http://127.0.0.1:${port}`,
			apiKey: TEST_API_KEY,
			workspaceId: workspace.id,
			webAppOrigin: WEB_APP_ORIGIN,
		}
		features = await detectFeatures(target)
	})

	afterAll(async () => {
		vi.unstubAllEnvs()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	for (const row of ROWS) {
		for (const style of row.styles) {
			it(`${row.id} [${style}]: ${row.title}`, async () => {
				const verdict = applicability(row, style, env, features)
				if (verdict.kind === 'n/a') return
				const result = await runRow(row, style, target, env, features)
				// "pending" is only reachable outside strict mode; it passes here and
				// is reported by the CLI. In CI the runner turns it into a failure.
				expect(result.status === 'pass' || result.status === 'pending', result.detail).toBe(true)
			})
		}
	}

	it('keeps the stdio entry point per-process', () => {
		// Stateless contract: the HTTP route builds a server per POST, and stdio
		// builds exactly one per process. A second transport would mean state held
		// across connections.
		const source = readFileSync(
			fileURLToPath(new URL('../../../../../packages/mcp/src/server.ts', import.meta.url)),
			'utf8',
		)
		expect(source.match(/new StdioServerTransport\(/g)).toHaveLength(1)
	})
})

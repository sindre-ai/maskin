import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * The request logger prints one line on receipt and one on completion. Those
 * lines carry the path only: anything from the first "?" to the next space
 * is dropped before printing.
 */

function buildApp() {
	const deps: AppDeps = {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

const PATH = '/api/integrations/linkedin-unipile/mcp'
const FAKE_VALUE = 'fake-value-123'

describe('request logger', () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
	})

	it('logs the path but not the query string', async () => {
		const res = await buildApp().request(`${PATH}?key=${FAKE_VALUE}`)
		await res.text()

		const lines = logSpy.mock.calls.map((args) => args.join(' '))
		expect(lines.length).toBeGreaterThanOrEqual(2)
		expect(lines.some((l) => l.includes(PATH))).toBe(true)
		for (const line of lines) {
			expect(line).not.toContain(FAKE_VALUE)
			expect(line).not.toContain('?')
		}
	})

	it('keeps the status and timing on the completion line', async () => {
		const res = await buildApp().request(`${PATH}?key=${FAKE_VALUE}`)
		await res.text()

		const lines = logSpy.mock.calls.map((args) => args.join(' '))
		const done = lines.find((l) => l.includes('-->'))
		expect(done).toMatch(/405/)
		expect(done).toMatch(/\d+ms|\d+s/)
	})
})

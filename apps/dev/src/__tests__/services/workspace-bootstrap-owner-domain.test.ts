import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspace } from '../factories'
import { createTestContext } from '../setup'

const { capturePosthogEventMock, loggerWarnMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
	loggerWarnMock: vi.fn(),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))
vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarnMock, error: vi.fn() },
}))

const { provisionWorkspace } = await import('../../services/workspace-bootstrap')

// The mock db has no notion of "after the transaction", and the owner-email
// lookup is the only select provisionWorkspace runs post-commit when there is
// no agentStorage / sessionManager. Wrap it so that select — and only that
// one — resolves (or rejects) as the test dictates.
function setup(ownerLookup: { email: string | null } | Error) {
	const { db: base, mockResults } = createTestContext()
	const ws = buildWorkspace()
	mockResults.insertQueue = [[ws], [{}]]
	mockResults.insert = [{ id: 'seeded-row-id' }]

	let committed = false
	const db = new Proxy(base, {
		get: (target, prop) => {
			if (prop === 'transaction') {
				return async (fn: (tx: Database) => Promise<unknown>) => {
					const result = await target.transaction(fn)
					committed = true
					return result
				}
			}
			if (prop === 'select' && committed) {
				return () => {
					const chain: Record<string, unknown> = {}
					for (const m of ['from', 'where', 'limit']) chain[m] = () => chain
					// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
					chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
						ownerLookup instanceof Error ? reject(ownerLookup) : resolve([ownerLookup])
					return chain
				}
			}
			return Reflect.get(target, prop)
		},
	})

	return { db, ws }
}

async function provision(db: Database) {
	return provisionWorkspace({
		db,
		agentStorage: undefined,
		sessionManager: undefined,
		name: 'Owner Domain',
		ownerActorId: 'owner-actor-id',
	})
}

function workspaceCreatedProps() {
	expect(capturePosthogEventMock).toHaveBeenCalledOnce()
	const [event, , properties] = capturePosthogEventMock.mock.calls[0] as [
		string,
		string,
		Record<string, unknown>,
	]
	expect(event).toBe('workspace_created')
	return properties
}

// provisionWorkspace also warns about the missing agentStorage in this setup,
// so count only the owner-lookup warning.
function lookupWarnings() {
	return loggerWarnMock.mock.calls.filter(([msg]) => String(msg).includes('owner email lookup'))
}

describe('provisionWorkspace — workspace_created owner_email_domain', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
		loggerWarnMock.mockClear()
	})

	it('sends the lowercased part after the last @ and nothing else of the address', async () => {
		const { db, ws } = setup({ email: 'Jane.Doe@Sub@Acme.CO.uk' })

		const result = await provision(db)

		expect(result?.id).toBe(ws.id)
		const props = workspaceCreatedProps()
		expect(props.owner_email_domain).toBe('acme.co.uk')
		expect(JSON.stringify(props)).not.toMatch(/jane|doe|@/i)
	})

	it('sends the event without the property when the owner has no email', async () => {
		const { db, ws } = setup({ email: null })

		const result = await provision(db)

		expect(result?.id).toBe(ws.id)
		expect(workspaceCreatedProps()).not.toHaveProperty('owner_email_domain')
		expect(lookupWarnings()).toHaveLength(0)
	})

	it('still fires the event and returns the workspace when the lookup throws', async () => {
		const { db, ws } = setup(new Error('connection reset'))

		const result = await provision(db)

		expect(result?.id).toBe(ws.id)
		expect(workspaceCreatedProps()).not.toHaveProperty('owner_email_domain')
		expect(lookupWarnings()).toHaveLength(1)
	})
})

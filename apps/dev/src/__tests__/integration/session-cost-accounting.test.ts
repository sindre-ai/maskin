import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { getModelPricingMock } = vi.hoisted(() => ({ getModelPricingMock: vi.fn() }))

vi.mock('../../lib/openrouter-pricing', () => ({ getModelPricing: getModelPricingMock }))

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

const DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash'

const DEEPSEEK_PRICING = {
	prompt: 0.00000007,
	completion: 0.00000014,
	cacheRead: 0.000000014,
	cacheWrite: 0,
}

// The CLI prices every turn against Anthropic's rate card. 1M in + 1M out is
// 0.21 USD at DeepSeek's published rates and 0.1234 USD as the CLI reports it,
// so the two are distinguishable in the assertion.
const CLI_REPORTED_COST_USD = 0.1234

const RESULT_ENVELOPE = JSON.stringify({
	type: 'result',
	total_cost_usd: CLI_REPORTED_COST_USD,
	duration_ms: 5000,
	usage: {
		input_tokens: 1_000_000,
		output_tokens: 1_000_000,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	},
})

// Cost accounting must split by route: sessions on `maskin_plan` reach a
// non-Anthropic model through OpenRouter, so the CLI-reported
// `total_cost_usd` (priced against Anthropic's rate card) is wrong for them
// and has to be recomputed from tokens. Sessions on `claude_oauth` genuinely
// reach Anthropic, so their CLI figure is already correct and must survive
// untouched. These tests drive the real completion path against Postgres —
// the resolver's unit tests pin the arithmetic, these pin the wiring and the
// row that actually lands.
describe('SessionManager.markRemoteSessionComplete — cost accounting by route (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		getModelPricingMock.mockReset()
		getModelPricingMock.mockImplementation(async (id: string) =>
			id === DEEPSEEK_MODEL ? DEEPSEEK_PRICING : null,
		)
	})

	async function completeSession(overrides: Record<string, unknown>) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			...overrides,
		})
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${RESULT_ENVELOPE}\n`,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		return row
	}

	it('prices a maskin_plan session from the model rates, discarding the CLI figure', async () => {
		const row = await completeSession({
			config: { llm_route: 'maskin_plan' },
			modelName: DEEPSEEK_MODEL,
		})

		expect(row?.status).toBe('completed')
		expect(row?.totalCostUsd).toBe('0.210000')
		expect(getModelPricingMock).toHaveBeenCalledWith(DEEPSEEK_MODEL)
		// Token counts still land — the cost is recomputed, not the usage.
		expect(row?.inputTokens).toBe(1_000_000)
		expect(row?.outputTokens).toBe(1_000_000)
	})

	it('keeps the CLI-reported cost for a claude_oauth session', async () => {
		const row = await completeSession({
			config: { llm_route: 'claude_oauth' },
			modelName: 'claude-opus-4-7',
		})

		expect(row?.status).toBe('completed')
		expect(row?.totalCostUsd).toBe('0.123400')
		// A route that reaches Anthropic never consults OpenRouter pricing.
		expect(getModelPricingMock).not.toHaveBeenCalled()
	})

	it('bills an unpriced maskin_plan model at the legacy token rate rather than zero', async () => {
		const row = await completeSession({
			config: { llm_route: 'maskin_plan' },
			modelName: 'some/unlisted-model',
		})

		// 2M tokens / 200_000 per cent / 100 cents per dollar.
		expect(row?.totalCostUsd).toBe('0.100000')
		expect(getModelPricingMock).toHaveBeenCalledWith('some/unlisted-model')
	})

	it('writes no cost at all when a maskin_plan session produced no result envelope', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'maskin_plan' },
			modelName: DEEPSEEK_MODEL,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		// No usage observed means no cost claim — never a silent zero.
		expect(row?.status).toBe('completed')
		expect(row?.totalCostUsd).toBeNull()
		expect(getModelPricingMock).not.toHaveBeenCalled()
	})
})

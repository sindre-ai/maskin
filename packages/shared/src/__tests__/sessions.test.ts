import { describe, expect, it } from 'vitest'
import {
	createSessionSchema,
	mcpServerHttpSchema,
	mcpServerSchema,
	mcpServerStdioSchema,
	sessionConfigSchema,
	sessionLogQuerySchema,
	sessionParamsSchema,
	sessionQuerySchema,
	sessionResultFailureReasonSchema,
	sessionResultSchema,
	sessionRuntimeSchema,
	sessionStatusSchema,
	sessionUsageQuerySchema,
} from '../schemas/sessions'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('sessionStatusSchema', () => {
	const statuses = [
		'pending',
		'queued',
		'starting',
		'running',
		'snapshotting',
		'paused',
		'waiting_for_input',
		'completed',
		'failed',
		'timeout',
	]

	for (const s of statuses) {
		it(`accepts ${s}`, () => {
			expect(sessionStatusSchema.parse(s)).toBe(s)
		})
	}

	it('rejects unknown status', () => {
		expect(() => sessionStatusSchema.parse('cancelled')).toThrow()
	})
})

describe('sessionRuntimeSchema', () => {
	it('accepts claude-code, codex, custom', () => {
		expect(sessionRuntimeSchema.parse('claude-code')).toBe('claude-code')
		expect(sessionRuntimeSchema.parse('codex')).toBe('codex')
		expect(sessionRuntimeSchema.parse('custom')).toBe('custom')
	})

	it('rejects unknown runtime', () => {
		expect(() => sessionRuntimeSchema.parse('gpt')).toThrow()
	})
})

describe('mcpServerStdioSchema', () => {
	it('accepts stdio server with defaults', () => {
		const result = mcpServerStdioSchema.parse({ command: 'node' })
		expect(result.type).toBe('stdio')
		expect(result.args).toEqual([])
		expect(result.env).toEqual({})
	})

	it('accepts full stdio config', () => {
		const result = mcpServerStdioSchema.parse({
			type: 'stdio',
			command: 'python',
			args: ['-m', 'server'],
			env: { DEBUG: '1' },
		})
		expect(result.command).toBe('python')
		expect(result.args).toEqual(['-m', 'server'])
	})
})

describe('mcpServerHttpSchema', () => {
	it('accepts http server', () => {
		const result = mcpServerHttpSchema.parse({
			type: 'http',
			url: 'https://mcp.example.com',
		})
		expect(result.type).toBe('http')
		expect(result.headers).toEqual({})
	})

	it('accepts headers', () => {
		const result = mcpServerHttpSchema.parse({
			type: 'http',
			url: 'https://mcp.example.com',
			headers: { Authorization: 'Bearer token' },
		})
		expect(result.headers.Authorization).toBe('Bearer token')
	})

	it('rejects missing url', () => {
		expect(() => mcpServerHttpSchema.parse({ type: 'http' })).toThrow()
	})
})

describe('mcpServerSchema', () => {
	it('accepts stdio server', () => {
		const result = mcpServerSchema.parse({ command: 'node' })
		expect(result.type).toBe('stdio')
	})

	it('accepts http server', () => {
		const result = mcpServerSchema.parse({ type: 'http', url: 'https://example.com' })
		expect(result.type).toBe('http')
	})
})

describe('sessionConfigSchema', () => {
	it('provides all defaults', () => {
		const result = sessionConfigSchema.parse({})
		expect(result.base_image).toBe('agent-base:latest')
		expect(result.runtime).toBe('claude-code')
		expect(result.runtime_config).toEqual({})
		expect(result.timeout_seconds).toBe(600)
		expect(result.memory_mb).toBe(4096)
		expect(result.cpu_shares).toBe(1024)
		expect(result.mcps).toEqual([])
		expect(result.env_vars).toEqual({})
		expect(result.interactive).toBe(false)
	})

	it('accepts interactive=true', () => {
		const result = sessionConfigSchema.parse({ interactive: true })
		expect(result.interactive).toBe(true)
	})

	it('coerces timeout_seconds from string', () => {
		const result = sessionConfigSchema.parse({ timeout_seconds: '300' })
		expect(result.timeout_seconds).toBe(300)
	})

	it('rejects timeout_seconds below 30', () => {
		expect(() => sessionConfigSchema.parse({ timeout_seconds: 29 })).toThrow()
	})

	it('rejects timeout_seconds above 3600', () => {
		expect(() => sessionConfigSchema.parse({ timeout_seconds: 3601 })).toThrow()
	})

	it('rejects memory_mb below 256', () => {
		expect(() => sessionConfigSchema.parse({ memory_mb: 128 })).toThrow()
	})

	it('rejects memory_mb above 8192', () => {
		expect(() => sessionConfigSchema.parse({ memory_mb: 16384 })).toThrow()
	})

	it('rejects cpu_shares below 256', () => {
		expect(() => sessionConfigSchema.parse({ cpu_shares: 100 })).toThrow()
	})

	it('rejects cpu_shares above 4096', () => {
		expect(() => sessionConfigSchema.parse({ cpu_shares: 8192 })).toThrow()
	})

	it('accepts mcps array', () => {
		const result = sessionConfigSchema.parse({
			mcps: [{ command: 'node', args: ['server.js'] }],
		})
		expect(result.mcps).toHaveLength(1)
	})
})

describe('createSessionSchema', () => {
	it('accepts valid session', () => {
		const result = createSessionSchema.parse({
			actor_id: uuid,
			action_prompt: 'Fix the bug',
		})
		expect(result.actor_id).toBe(uuid)
		expect(result.action_prompt).toBe('Fix the bug')
		expect(result.auto_start).toBe(true)
	})

	it('defaults auto_start to true', () => {
		const result = createSessionSchema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
		})
		expect(result.auto_start).toBe(true)
	})

	it('accepts auto_start as false', () => {
		const result = createSessionSchema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
			auto_start: false,
		})
		expect(result.auto_start).toBe(false)
	})

	it('accepts optional trigger_id', () => {
		const result = createSessionSchema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
			trigger_id: uuid,
		})
		expect(result.trigger_id).toBe(uuid)
	})

	it('defaults config to empty partial', () => {
		const result = createSessionSchema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
		})
		expect(result.config).toEqual({})
	})

	it('rejects missing actor_id', () => {
		expect(() => createSessionSchema.parse({ action_prompt: 'Test' })).toThrow()
	})

	it('rejects missing action_prompt', () => {
		expect(() => createSessionSchema.parse({ actor_id: uuid })).toThrow()
	})

	it('rejects empty action_prompt', () => {
		expect(() => createSessionSchema.parse({ actor_id: uuid, action_prompt: '' })).toThrow()
	})
})

describe('sessionQuerySchema', () => {
	it('provides default limit of 20', () => {
		const result = sessionQuerySchema.parse({})
		expect(result.limit).toBe(20)
		expect(result.offset).toBe(0)
	})

	it('accepts optional status filter', () => {
		const result = sessionQuerySchema.parse({ status: 'running' })
		expect(result.status).toBe('running')
	})

	it('accepts optional actor_id filter', () => {
		const result = sessionQuerySchema.parse({ actor_id: uuid })
		expect(result.actor_id).toBe(uuid)
	})
})

describe('sessionLogQuerySchema', () => {
	it('provides default limit of 100', () => {
		const result = sessionLogQuerySchema.parse({})
		expect(result.limit).toBe(100)
	})

	it('accepts optional stream filter', () => {
		const result = sessionLogQuerySchema.parse({ stream: 'stdout' })
		expect(result.stream).toBe('stdout')
	})

	it('rejects invalid stream value', () => {
		expect(() => sessionLogQuerySchema.parse({ stream: 'output' })).toThrow()
	})

	it('accepts max limit of 500', () => {
		const result = sessionLogQuerySchema.parse({ limit: 500 })
		expect(result.limit).toBe(500)
	})

	it('rejects limit above 500', () => {
		expect(() => sessionLogQuerySchema.parse({ limit: 501 })).toThrow()
	})
})

describe('sessionParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(sessionParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => sessionParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})

describe('sessionUsageQuerySchema', () => {
	const valid = {
		actor_id: uuid,
		from: '2026-01-01T00:00:00Z',
		to: '2026-01-08T00:00:00Z',
		bucket: 'day' as const,
	}

	it('accepts a valid query', () => {
		const result = sessionUsageQuerySchema.parse(valid)
		expect(result.actor_id).toBe(uuid)
		expect(result.bucket).toBe('day')
	})

	it('accepts hour and week buckets', () => {
		expect(sessionUsageQuerySchema.parse({ ...valid, bucket: 'hour' }).bucket).toBe('hour')
		expect(sessionUsageQuerySchema.parse({ ...valid, bucket: 'week' }).bucket).toBe('week')
	})

	it('rejects unknown bucket', () => {
		expect(() => sessionUsageQuerySchema.parse({ ...valid, bucket: 'month' })).toThrow()
	})

	it('rejects non-uuid actor_id', () => {
		expect(() => sessionUsageQuerySchema.parse({ ...valid, actor_id: 'nope' })).toThrow()
	})

	it('rejects non-ISO datetimes', () => {
		expect(() => sessionUsageQuerySchema.parse({ ...valid, from: 'yesterday' })).toThrow()
	})
})

describe('sessionResultFailureReasonSchema', () => {
	const full = {
		provider: 'anthropic',
		reason_code: 'billing_error',
		human_message: 'Your Anthropic credits are exhausted.',
		http_status: 402,
		reset_at: '2026-07-01T00:00:00.000Z',
		verbatim_output: 'Error: credit limit reached',
	}

	it('accepts a fully populated failure reason', () => {
		const result = sessionResultFailureReasonSchema.parse(full)
		expect(result.provider).toBe('anthropic')
		expect(result.reason_code).toBe('billing_error')
		expect(result.http_status).toBe(402)
	})

	it('accepts nullable fields as null', () => {
		const result = sessionResultFailureReasonSchema.parse({
			...full,
			http_status: null,
			reset_at: null,
			verbatim_output: null,
		})
		expect(result.http_status).toBeNull()
		expect(result.reset_at).toBeNull()
		expect(result.verbatim_output).toBeNull()
	})

	it('rejects unknown reason_code values', () => {
		expect(() =>
			sessionResultFailureReasonSchema.parse({ ...full, reason_code: 'credit_exhausted' }),
		).toThrow()
	})

	it('rejects missing required fields', () => {
		expect(() =>
			sessionResultFailureReasonSchema.parse({ provider: 'anthropic' }),
		).toThrow()
	})
})

describe('sessionResultSchema', () => {
	it('accepts a completed result with exit_code only', () => {
		const result = sessionResultSchema.parse({ exit_code: 0 })
		expect(result.exit_code).toBe(0)
		expect(result.failure_reason).toBeUndefined()
	})

	it('accepts a failed result with error only', () => {
		const result = sessionResultSchema.parse({ error: 'Session timed out' })
		expect(result.error).toBe('Session timed out')
	})

	it('accepts failure_reason: null (unclassified)', () => {
		const result = sessionResultSchema.parse({ exit_code: 1, failure_reason: null })
		expect(result.failure_reason).toBeNull()
	})

	it('accepts a result with a populated failure_reason', () => {
		const result = sessionResultSchema.parse({
			exit_code: 1,
			failure_reason: {
				provider: 'openrouter',
				reason_code: 'insufficient_credits',
				human_message: 'Out of credits.',
				http_status: 402,
				reset_at: null,
				verbatim_output: null,
			},
		})
		expect(result.failure_reason?.provider).toBe('openrouter')
		expect(result.failure_reason?.reason_code).toBe('insufficient_credits')
	})

	it('accepts an empty object (all fields optional)', () => {
		const result = sessionResultSchema.parse({})
		expect(result.exit_code).toBeUndefined()
		expect(result.error).toBeUndefined()
		expect(result.failure_reason).toBeUndefined()
	})
})

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
	sessionRuntimeSchema,
	sessionStatusSchema,
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

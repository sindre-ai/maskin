import { describe, expect, it } from 'vitest'
import {
	actorParamsSchema,
	actorToolsSchema,
	actorTypeSchema,
	createActorSchema,
	llmConfigSchema,
	loginSchema,
	updateActorSchema,
} from '../schemas/actors'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('actorTypeSchema', () => {
	it('accepts human and agent', () => {
		expect(actorTypeSchema.parse('human')).toBe('human')
		expect(actorTypeSchema.parse('agent')).toBe('agent')
	})

	it('rejects unknown types', () => {
		expect(() => actorTypeSchema.parse('bot')).toThrow()
	})
})

describe('actorToolsSchema', () => {
	it('defaults mcpServers to empty object', () => {
		const result = actorToolsSchema.parse({})
		expect(result.mcpServers).toEqual({})
	})

	it('accepts mcpServers with stdio config', () => {
		const result = actorToolsSchema.parse({
			mcpServers: {
				myServer: { type: 'stdio', command: 'node', args: ['server.js'] },
			},
		})
		const server = result.mcpServers.myServer
		expect(server).toBeDefined()
		expect(server?.type).toBe('stdio')
	})
})

describe('llmConfigSchema', () => {
	it('accepts empty object', () => {
		const result = llmConfigSchema.parse({})
		expect(result).toEqual({})
	})

	it('accepts api_key and model', () => {
		const result = llmConfigSchema.parse({ api_key: 'sk-test', model: 'claude-3' })
		expect(result.api_key).toBe('sk-test')
		expect(result.model).toBe('claude-3')
	})
})

describe('createActorSchema', () => {
	it('accepts valid human actor', () => {
		const result = createActorSchema.parse({
			type: 'human',
			name: 'Alice',
			email: 'alice@example.com',
			password: 'password123',
		})
		expect(result.type).toBe('human')
		expect(result.name).toBe('Alice')
	})

	it('accepts valid agent actor', () => {
		const result = createActorSchema.parse({
			type: 'agent',
			name: 'Bot',
			system_prompt: 'You are a helpful agent',
		})
		expect(result.type).toBe('agent')
		expect(result.system_prompt).toBe('You are a helpful agent')
	})

	it('accepts optional id as uuid', () => {
		const result = createActorSchema.parse({ type: 'human', name: 'Alice', id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('rejects missing type', () => {
		expect(() => createActorSchema.parse({ name: 'Alice' })).toThrow()
	})

	it('rejects missing name', () => {
		expect(() => createActorSchema.parse({ type: 'human' })).toThrow()
	})

	it('rejects empty name', () => {
		expect(() => createActorSchema.parse({ type: 'human', name: '' })).toThrow()
	})

	it('rejects invalid email format', () => {
		expect(() =>
			createActorSchema.parse({ type: 'human', name: 'A', email: 'not-email' }),
		).toThrow()
	})

	it('rejects password shorter than 8 chars', () => {
		expect(() => createActorSchema.parse({ type: 'human', name: 'A', password: 'short' })).toThrow()
	})

	it('accepts auto_create_workspace boolean', () => {
		const result = createActorSchema.parse({
			type: 'human',
			name: 'A',
			auto_create_workspace: true,
		})
		expect(result.auto_create_workspace).toBe(true)
	})
})

describe('loginSchema', () => {
	it('accepts valid email and password', () => {
		const result = loginSchema.parse({ email: 'user@test.com', password: 'pass' })
		expect(result.email).toBe('user@test.com')
	})

	it('rejects missing email', () => {
		expect(() => loginSchema.parse({ password: 'pass' })).toThrow()
	})

	it('rejects missing password', () => {
		expect(() => loginSchema.parse({ email: 'user@test.com' })).toThrow()
	})

	it('rejects invalid email', () => {
		expect(() => loginSchema.parse({ email: 'invalid', password: 'pass' })).toThrow()
	})
})

describe('updateActorSchema', () => {
	it('accepts empty object', () => {
		expect(updateActorSchema.parse({})).toEqual({})
	})

	it('accepts partial fields', () => {
		const result = updateActorSchema.parse({ name: 'Updated' })
		expect(result.name).toBe('Updated')
	})

	it('rejects empty name', () => {
		expect(() => updateActorSchema.parse({ name: '' })).toThrow()
	})

	it('rejects invalid email', () => {
		expect(() => updateActorSchema.parse({ email: 'bad' })).toThrow()
	})

	it('accepts memory as record', () => {
		const result = updateActorSchema.parse({ memory: { key: 'value' } })
		expect(result.memory).toEqual({ key: 'value' })
	})
})

describe('actorParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(actorParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => actorParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})

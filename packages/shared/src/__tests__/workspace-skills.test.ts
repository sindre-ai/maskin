import { describe, expect, it } from 'vitest'
import {
	attachSkillSchema,
	createWorkspaceSkillSchema,
	updateWorkspaceSkillSchema,
	workspaceSkillSchema,
} from '../schemas/workspace-skills'

describe('createWorkspaceSkillSchema', () => {
	it('accepts valid kebab-case name and non-empty content', () => {
		const result = createWorkspaceSkillSchema.parse({
			name: 'my-skill',
			content: '# SKILL.md\n\nBody',
		})
		expect(result.name).toBe('my-skill')
		expect(result.content).toBe('# SKILL.md\n\nBody')
	})

	it('accepts name with numbers', () => {
		expect(createWorkspaceSkillSchema.parse({ name: 'skill-123', content: 'x' }).name).toBe(
			'skill-123',
		)
	})

	it('rejects uppercase letters in name', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'MySkill', content: 'x' })).toThrow()
	})

	it('rejects underscores in name', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'my_skill', content: 'x' })).toThrow()
	})

	it('rejects spaces in name', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'my skill', content: 'x' })).toThrow()
	})

	it('rejects empty name', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: '', content: 'x' })).toThrow()
	})

	it('rejects name longer than 64 chars', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'a'.repeat(65), content: 'x' })).toThrow()
	})

	it('rejects empty content', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'valid', content: '' })).toThrow()
	})

	it('rejects missing content', () => {
		expect(() => createWorkspaceSkillSchema.parse({ name: 'valid' })).toThrow()
	})

	it('rejects extra fields like description (server derives it from frontmatter)', () => {
		// Zod is permissive by default — verify description is stripped, not required
		const result = createWorkspaceSkillSchema.parse({
			name: 'valid',
			content: 'body',
			description: 'should be ignored',
		} as unknown as { name: string; content: string })
		expect((result as { description?: string }).description).toBeUndefined()
	})
})

describe('updateWorkspaceSkillSchema', () => {
	it('accepts non-empty content', () => {
		expect(updateWorkspaceSkillSchema.parse({ content: 'new body' }).content).toBe('new body')
	})

	it('rejects empty content', () => {
		expect(() => updateWorkspaceSkillSchema.parse({ content: '' })).toThrow()
	})

	it('rejects missing content', () => {
		expect(() => updateWorkspaceSkillSchema.parse({})).toThrow()
	})
})

describe('attachSkillSchema', () => {
	it('accepts a uuid', () => {
		const id = '11111111-1111-4111-8111-111111111111'
		expect(attachSkillSchema.parse({ workspaceSkillId: id }).workspaceSkillId).toBe(id)
	})

	it('rejects a non-uuid', () => {
		expect(() => attachSkillSchema.parse({ workspaceSkillId: 'not-a-uuid' })).toThrow()
	})

	it('rejects missing workspaceSkillId', () => {
		expect(() => attachSkillSchema.parse({})).toThrow()
	})
})

describe('workspaceSkillSchema', () => {
	const baseRow = {
		id: '11111111-1111-4111-8111-111111111111',
		workspaceId: '22222222-2222-4222-8222-222222222222',
		name: 'my-skill',
		description: 'A helpful skill',
		content: '# SKILL.md\n\nBody',
		storageKey: 'workspaces/22222222-2222-4222-8222-222222222222/skills/my-skill/SKILL.md',
		sizeBytes: 17,
		isValid: true,
		createdBy: '33333333-3333-4333-8333-333333333333',
		createdAt: '2026-04-23T08:21:32.362Z',
		updatedAt: '2026-04-23T08:21:32.362Z',
	}

	it('accepts a full row', () => {
		const result = workspaceSkillSchema.parse(baseRow)
		expect(result.name).toBe('my-skill')
		expect(result.sizeBytes).toBe(17)
	})

	it('accepts null description and createdBy', () => {
		const result = workspaceSkillSchema.parse({
			...baseRow,
			description: null,
			createdBy: null,
		})
		expect(result.description).toBeNull()
		expect(result.createdBy).toBeNull()
	})

	it('rejects invalid name', () => {
		expect(() => workspaceSkillSchema.parse({ ...baseRow, name: 'Bad_Name' })).toThrow()
	})

	it('rejects negative sizeBytes', () => {
		expect(() => workspaceSkillSchema.parse({ ...baseRow, sizeBytes: -1 })).toThrow()
	})
})

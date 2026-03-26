import { describe, expect, it } from 'vitest'
import {
	parseSkillMd,
	saveSkillSchema,
	serializeSkillMd,
	skillFrontmatterSchema,
	skillNameSchema,
} from '../schemas/skills'

describe('skillFrontmatterSchema', () => {
	it('accepts empty object', () => {
		expect(skillFrontmatterSchema.parse({})).toEqual({})
	})

	it('accepts all optional fields', () => {
		const result = skillFrontmatterSchema.parse({
			disable_model_invocation: true,
			user_invocable: false,
			allowed_tools: 'Read,Write',
			context: 'fork',
			agent: 'my-agent',
			model: 'claude-3',
			argument_hint: 'URL',
			effort: 'high',
		})
		expect(result.disable_model_invocation).toBe(true)
		expect(result.effort).toBe('high')
	})

	it('rejects invalid effort value', () => {
		expect(() => skillFrontmatterSchema.parse({ effort: 'extreme' })).toThrow()
	})

	it('rejects invalid context value', () => {
		expect(() => skillFrontmatterSchema.parse({ context: 'main' })).toThrow()
	})
})

describe('saveSkillSchema', () => {
	it('accepts valid skill', () => {
		const result = saveSkillSchema.parse({
			description: 'A test skill',
			content: 'Do the thing',
		})
		expect(result.description).toBe('A test skill')
		expect(result.content).toBe('Do the thing')
	})

	it('accepts optional frontmatter', () => {
		const result = saveSkillSchema.parse({
			description: 'Test',
			content: 'Content',
			frontmatter: { effort: 'low' },
		})
		expect(result.frontmatter?.effort).toBe('low')
	})

	it('rejects empty description', () => {
		expect(() => saveSkillSchema.parse({ description: '', content: 'test' })).toThrow()
	})

	it('rejects missing content', () => {
		expect(() => saveSkillSchema.parse({ description: 'test' })).toThrow()
	})
})

describe('skillNameSchema', () => {
	it('accepts lowercase with hyphens', () => {
		expect(skillNameSchema.parse('my-skill')).toBe('my-skill')
	})

	it('accepts lowercase with numbers', () => {
		expect(skillNameSchema.parse('skill-123')).toBe('skill-123')
	})

	it('accepts single character', () => {
		expect(skillNameSchema.parse('a')).toBe('a')
	})

	it('rejects uppercase letters', () => {
		expect(() => skillNameSchema.parse('MySkill')).toThrow()
	})

	it('rejects spaces', () => {
		expect(() => skillNameSchema.parse('my skill')).toThrow()
	})

	it('rejects special characters', () => {
		expect(() => skillNameSchema.parse('my_skill')).toThrow()
	})

	it('rejects empty string', () => {
		expect(() => skillNameSchema.parse('')).toThrow()
	})

	it('rejects string longer than 64 chars', () => {
		expect(() => skillNameSchema.parse('a'.repeat(65))).toThrow()
	})

	it('accepts 64 char string', () => {
		expect(skillNameSchema.parse('a'.repeat(64))).toHaveLength(64)
	})
})

describe('parseSkillMd', () => {
	it('parses frontmatter and content', () => {
		const md = `---
name: my-skill
description: A helpful skill
user-invocable: true
---

Do the thing here.`
		const result = parseSkillMd(md)
		expect(result.name).toBe('my-skill')
		expect(result.description).toBe('A helpful skill')
		expect(result.frontmatter.user_invocable).toBe(true)
		expect(result.content).toBe('Do the thing here.')
	})

	it('converts kebab-case keys to underscore', () => {
		const md = `---
name: test
description: test
disable-model-invocation: true
---

Content`
		const result = parseSkillMd(md)
		expect(result.frontmatter.disable_model_invocation).toBe(true)
	})

	it('converts false string to boolean', () => {
		const md = `---
name: test
description: test
user-invocable: false
---

Content`
		const result = parseSkillMd(md)
		expect(result.frontmatter.user_invocable).toBe(false)
	})

	it('handles content without frontmatter', () => {
		const md = 'Just some content without frontmatter'
		const result = parseSkillMd(md)
		expect(result.name).toBe('')
		expect(result.description).toBe('')
		expect(result.content).toBe(md)
	})

	it('extracts name and description from frontmatter', () => {
		const md = `---
name: extracted
description: The description
---

Body`
		const result = parseSkillMd(md)
		expect(result.name).toBe('extracted')
		expect(result.description).toBe('The description')
	})
})

describe('serializeSkillMd', () => {
	it('serializes skill to markdown', () => {
		const result = serializeSkillMd({
			name: 'my-skill',
			description: 'A skill',
			content: 'Do things',
		})
		expect(result).toContain('---')
		expect(result).toContain('name: my-skill')
		expect(result).toContain('description: A skill')
		expect(result).toContain('Do things')
	})

	it('includes frontmatter fields', () => {
		const result = serializeSkillMd({
			name: 'test',
			description: 'test',
			frontmatter: { user_invocable: true, effort: 'high' },
			content: 'Content',
		})
		expect(result).toContain('user-invocable: true')
		expect(result).toContain('effort: high')
	})

	it('converts underscore keys to kebab-case', () => {
		const result = serializeSkillMd({
			name: 'test',
			description: 'test',
			frontmatter: { disable_model_invocation: true },
			content: 'Content',
		})
		expect(result).toContain('disable-model-invocation: true')
	})

	it('omits undefined and empty frontmatter values', () => {
		const result = serializeSkillMd({
			name: 'test',
			description: 'test',
			frontmatter: { effort: undefined as unknown as 'low', model: '' },
			content: 'Content',
		})
		expect(result).not.toContain('effort')
		expect(result).not.toContain('model')
	})

	it('round-trips with parseSkillMd', () => {
		const original = {
			name: 'round-trip',
			description: 'A round trip test',
			frontmatter: { user_invocable: true, effort: 'medium' as const },
			content: 'Test content here',
		}
		const serialized = serializeSkillMd(original)
		const parsed = parseSkillMd(serialized)
		expect(parsed.name).toBe(original.name)
		expect(parsed.description).toBe(original.description)
		expect(parsed.frontmatter.user_invocable).toBe(true)
		expect(parsed.frontmatter.effort).toBe('medium')
		expect(parsed.content).toBe(original.content)
	})
})

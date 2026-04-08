import { parseSkillMd, saveSkillSchema, serializeSkillMd, skillNameSchema } from '@maskin/shared'
import { describe, expect, it } from 'vitest'

describe('skillNameSchema', () => {
	it('accepts valid names', () => {
		expect(skillNameSchema.safeParse('deploy').success).toBe(true)
		expect(skillNameSchema.safeParse('review-pr').success).toBe(true)
		expect(skillNameSchema.safeParse('my-skill-123').success).toBe(true)
	})

	it('rejects uppercase', () => {
		expect(skillNameSchema.safeParse('Deploy').success).toBe(false)
	})

	it('rejects spaces', () => {
		expect(skillNameSchema.safeParse('my skill').success).toBe(false)
	})

	it('rejects empty string', () => {
		expect(skillNameSchema.safeParse('').success).toBe(false)
	})

	it('rejects names over 64 chars', () => {
		expect(skillNameSchema.safeParse('a'.repeat(65)).success).toBe(false)
		expect(skillNameSchema.safeParse('a'.repeat(64)).success).toBe(true)
	})

	it('rejects special characters', () => {
		expect(skillNameSchema.safeParse('my_skill').success).toBe(false)
		expect(skillNameSchema.safeParse('my.skill').success).toBe(false)
	})
})

describe('saveSkillSchema', () => {
	it('accepts valid input', () => {
		const result = saveSkillSchema.safeParse({
			description: 'A test skill',
			content: 'Do the thing',
		})
		expect(result.success).toBe(true)
	})

	it('accepts input with frontmatter', () => {
		const result = saveSkillSchema.safeParse({
			description: 'A test skill',
			content: 'Do the thing',
			frontmatter: {
				disable_model_invocation: true,
				context: 'fork',
				model: 'sonnet',
			},
		})
		expect(result.success).toBe(true)
	})

	it('rejects empty description', () => {
		const result = saveSkillSchema.safeParse({
			description: '',
			content: 'Do the thing',
		})
		expect(result.success).toBe(false)
	})

	it('rejects invalid frontmatter context', () => {
		const result = saveSkillSchema.safeParse({
			description: 'A test skill',
			content: '',
			frontmatter: { context: 'invalid' },
		})
		expect(result.success).toBe(false)
	})

	it('rejects invalid effort value', () => {
		const result = saveSkillSchema.safeParse({
			description: 'A test skill',
			content: '',
			frontmatter: { effort: 'extreme' },
		})
		expect(result.success).toBe(false)
	})
})

describe('parseSkillMd', () => {
	it('parses a full SKILL.md with frontmatter', () => {
		const raw = `---
name: deploy
description: Deploy the app to production
disable-model-invocation: true
context: fork
---

Run the deploy script.`

		const result = parseSkillMd(raw)
		expect(result.name).toBe('deploy')
		expect(result.description).toBe('Deploy the app to production')
		expect(result.frontmatter.disable_model_invocation).toBe(true)
		expect(result.frontmatter.context).toBe('fork')
		expect(result.content).toBe('Run the deploy script.')
	})

	it('parses skill with only name and description', () => {
		const raw = `---
name: simple
description: A simple skill
---

Just do it.`

		const result = parseSkillMd(raw)
		expect(result.name).toBe('simple')
		expect(result.description).toBe('A simple skill')
		expect(result.content).toBe('Just do it.')
	})

	it('returns empty name/description when frontmatter is missing', () => {
		const raw = 'Just plain markdown content'
		const result = parseSkillMd(raw)
		expect(result.name).toBe('')
		expect(result.description).toBe('')
		expect(result.content).toBe('Just plain markdown content')
	})

	it('handles boolean values correctly', () => {
		const raw = `---
name: test
description: test
disable-model-invocation: true
user-invocable: false
---

Content`

		const result = parseSkillMd(raw)
		expect(result.frontmatter.disable_model_invocation).toBe(true)
		expect(result.frontmatter.user_invocable).toBe(false)
	})

	it('converts hyphenated keys to underscored', () => {
		const raw = `---
name: test
description: test
allowed-tools: Read, Grep
---

Content`

		const result = parseSkillMd(raw)
		expect(result.frontmatter.allowed_tools).toBe('Read, Grep')
	})

	it('handles multiline content after frontmatter', () => {
		const raw = `---
name: multi
description: Multi-line content
---

Line one.

Line two.

Line three.`

		const result = parseSkillMd(raw)
		expect(result.content).toContain('Line one.')
		expect(result.content).toContain('Line two.')
		expect(result.content).toContain('Line three.')
	})
})

describe('serializeSkillMd', () => {
	it('produces valid SKILL.md format', () => {
		const raw = serializeSkillMd({
			name: 'deploy',
			description: 'Deploy to prod',
			content: 'Run deploy.',
		})

		expect(raw).toContain('---')
		expect(raw).toContain('name: deploy')
		expect(raw).toContain('description: Deploy to prod')
		expect(raw).toContain('Run deploy.')
	})

	it('includes frontmatter fields', () => {
		const raw = serializeSkillMd({
			name: 'test',
			description: 'Test skill',
			frontmatter: {
				disable_model_invocation: true,
				context: 'fork',
				model: 'sonnet',
			},
			content: 'Do stuff.',
		})

		expect(raw).toContain('disable-model-invocation: true')
		expect(raw).toContain('context: fork')
		expect(raw).toContain('model: sonnet')
	})

	it('omits undefined/empty frontmatter fields', () => {
		const raw = serializeSkillMd({
			name: 'test',
			description: 'Test',
			frontmatter: {
				disable_model_invocation: undefined,
				allowed_tools: '',
			},
			content: 'Content.',
		})

		expect(raw).not.toContain('disable-model-invocation')
		expect(raw).not.toContain('allowed-tools')
	})

	it('roundtrips through parse → serialize', () => {
		const original = `---
name: roundtrip
description: Test roundtrip
context: fork
model: opus
---

Instructions here.`

		const parsed = parseSkillMd(original)
		const serialized = serializeSkillMd(parsed)
		const reparsed = parseSkillMd(serialized)

		expect(reparsed.name).toBe(parsed.name)
		expect(reparsed.description).toBe(parsed.description)
		expect(reparsed.frontmatter.context).toBe(parsed.frontmatter.context)
		expect(reparsed.frontmatter.model).toBe(parsed.frontmatter.model)
		expect(reparsed.content).toBe(parsed.content)
	})
})

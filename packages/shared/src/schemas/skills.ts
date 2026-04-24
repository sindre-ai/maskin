import { z } from 'zod'

// -- Zod schemas --

export const skillFrontmatterSchema = z.object({
	disable_model_invocation: z.boolean().optional(),
	user_invocable: z.boolean().optional(),
	allowed_tools: z.string().optional(),
	context: z.enum(['fork']).optional(),
	agent: z.string().optional(),
	model: z.string().optional(),
	argument_hint: z.string().optional(),
	effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
})

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export const saveSkillSchema = z.object({
	description: z.string().min(1),
	content: z.string(),
	frontmatter: skillFrontmatterSchema.optional(),
})

export type SaveSkillInput = z.infer<typeof saveSkillSchema>

export const skillNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, and hyphens only')

// -- SKILL.md parser/serializer --

export interface ParsedSkill {
	name: string
	description: string
	frontmatter: SkillFrontmatter
	content: string
}

/**
 * Parse a SKILL.md file into structured parts.
 * Handles YAML frontmatter between --- delimiters.
 */
export function parseSkillMd(raw: string): ParsedSkill {
	const frontmatter: Record<string, unknown> = {}
	let content = raw

	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
	if (match && match[1] !== undefined && match[2] !== undefined) {
		const yamlBlock = match[1]
		content = match[2].trim()

		for (const line of yamlBlock.split('\n')) {
			const kvMatch = line.match(/^([a-z_-]+)\s*:\s*(.+)$/)
			if (kvMatch && kvMatch[1] !== undefined && kvMatch[2] !== undefined) {
				const key = kvMatch[1].replace(/-/g, '_')
				let value: unknown = kvMatch[2].trim()
				if (value === 'true') value = true
				else if (value === 'false') value = false
				frontmatter[key] = value
			}
		}
	}

	const name = (frontmatter.name as string) ?? ''
	const description = (frontmatter.description as string) ?? ''
	frontmatter.name = undefined
	frontmatter.description = undefined

	return {
		name,
		description,
		frontmatter: skillFrontmatterSchema.parse(frontmatter),
		content,
	}
}

/**
 * Serialize structured skill data back to SKILL.md format.
 *
 * Only keys present in `SkillFrontmatter` (plus `name` and `description`) are
 * emitted. Custom/unrecognised frontmatter keys on the input SKILL.md are
 * dropped by `parseSkillMd` and will therefore NOT survive a
 * parse → serialize round-trip. Callers that rewrite stored SKILL.md content
 * (e.g. the workspace-skills update route) must document this to users.
 */
export function serializeSkillMd(skill: {
	name: string
	description: string
	frontmatter?: SkillFrontmatter
	content: string
}): string {
	const lines: string[] = ['---']
	lines.push(`name: ${skill.name}`)
	lines.push(`description: ${skill.description}`)

	if (skill.frontmatter) {
		for (const [key, value] of Object.entries(skill.frontmatter)) {
			if (value !== undefined && value !== null && value !== '') {
				const yamlKey = key.replace(/_/g, '-')
				lines.push(`${yamlKey}: ${value}`)
			}
		}
	}

	lines.push('---')
	lines.push('')
	lines.push(skill.content)

	return lines.join('\n')
}

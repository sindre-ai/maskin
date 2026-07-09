import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_AGENTS } from '../templates/development-agents'

function getMcpServers(tools: unknown): Record<string, unknown> {
	const t = tools as { mcpServers?: Record<string, unknown> } | undefined
	return t?.mcpServers ?? {}
}

describe('DEVELOPMENT_AGENTS context7 wiring', () => {
	it('registers context7 on the Senior Developer with the canonical HTTP tuple', () => {
		const dev = DEVELOPMENT_AGENTS.find((a) => a.$id === 'senior_developer')
		expect(dev).toBeDefined()

		const servers = getMcpServers(dev?.tools)
		expect(servers.context7).toEqual({
			url: 'https://mcp.context7.com/mcp',
			type: 'http',
		})
	})

	it('preserves the existing github + maskin entries on the Senior Developer', () => {
		const dev = DEVELOPMENT_AGENTS.find((a) => a.$id === 'senior_developer')
		const servers = getMcpServers(dev?.tools)
		expect(servers.github).toBeDefined()
		expect(servers.maskin).toBeDefined()
	})

	it('does NOT register context7 on any other DEVELOPMENT_AGENTS entry', () => {
		const leaked = DEVELOPMENT_AGENTS.filter(
			(a) => a.$id !== 'senior_developer' && 'context7' in getMcpServers(a.tools),
		).map((a) => a.$id)
		expect(leaked).toEqual([])
	})
})

describe('DEVELOPMENT_AGENTS code_reviewer tag taxonomy', () => {
	// The success metric of "Give build agents a code-time docs/API reference lookup"
	// counts Code Reviewer findings tagged with these exact strings. Renaming or
	// removing them silently breaks the metric — keep this test in sync with the
	// prompt.
	const REQUIRED_TAGS = ['[wrong-api]', '[hallucinated-signature]', '[version-mismatch]'] as const

	function getCodeReviewerPrompt(): string {
		const cr = DEVELOPMENT_AGENTS.find((a) => a.$id === 'code_reviewer')
		expect(cr, 'code_reviewer agent must exist in DEVELOPMENT_AGENTS').toBeDefined()
		return cr?.systemPrompt ?? ''
	}

	it.each(REQUIRED_TAGS)('names %s in the Code Reviewer system prompt', (tag) => {
		expect(getCodeReviewerPrompt()).toContain(tag)
	})

	it('instructs the Code Reviewer to prefix findings with a bracketed category tag', () => {
		const prompt = getCodeReviewerPrompt()
		expect(prompt.toLowerCase()).toContain('bracketed category tag')
	})

	it('records a one-line definition per new tag', () => {
		// Each of the three new tags must carry a definition (a `- \`[tag]\`` bullet
		// followed by content on the same line) so two reviewers land on the same tag
		// for the same finding.
		const prompt = getCodeReviewerPrompt()
		for (const tag of REQUIRED_TAGS) {
			const pattern = new RegExp(`- \`${tag.replace(/[[\]]/g, '\\$&')}\`.+`)
			expect(prompt).toMatch(pattern)
		}
	})
})

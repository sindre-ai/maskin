import { describe, expect, it } from 'vitest'
// The proxy lib lives in docker/agent-base/ so it can ship in the agent
// container image. Imported here via a relative path — the lib is pure and
// side-effect-free, so no shim is needed.
import {
	KNOWN_TOOLS,
	buildInitializeResponse,
	buildMintUrl,
	buildToolsListResponse,
	extractRepoFromArgs,
	formatJsonRpcError,
	formatJsonRpcResult,
	parseJsonRpcLines,
	// @ts-expect-error — .mjs file with implicit JSDoc types.
} from '../../../../../docker/agent-base/github-mcp-proxy-lib.mjs'

describe('github-mcp-proxy lib', () => {
	describe('KNOWN_TOOLS inventory', () => {
		it('covers every write tool the parent bet flagged', () => {
			// AC #3 hits API-side write tools first — leaked write tokens are
			// the parent bet's motivating risk. If any of these silently
			// disappear from the mapping, the proxy 400s them, so the loss is
			// loud, but this test makes sure they were mapped in the first place.
			expect(KNOWN_TOOLS.merge_pull_request).toBe('both')
			expect(KNOWN_TOOLS.create_pull_request).toBe('both')
			expect(KNOWN_TOOLS.create_pull_request_review).toBe('both')
			expect(KNOWN_TOOLS.update_pull_request_branch).toBe('both')
			expect(KNOWN_TOOLS.push_files).toBe('both')
			expect(KNOWN_TOOLS.create_or_update_file).toBe('both')
			expect(KNOWN_TOOLS.create_branch).toBe('both')
		})

		it('marks search tools as repo-less so the mint route only narrows on permissions', () => {
			// search_code / search_repositories / search_users cross repos by
			// design — passing a repo hint would either 400 the mint route or
			// artificially cap the search to one repo.
			expect(KNOWN_TOOLS.search_code).toBe('none')
			expect(KNOWN_TOOLS.search_repositories).toBe('none')
			expect(KNOWN_TOOLS.search_users).toBe('none')
		})
	})

	describe('extractRepoFromArgs', () => {
		it('returns owner/repo when both are well-formed strings', () => {
			expect(extractRepoFromArgs({ owner: 'sindre-ai', repo: 'maskin' })).toBe('sindre-ai/maskin')
		})

		it('returns undefined when args are missing, null, or the wrong shape', () => {
			expect(extractRepoFromArgs(undefined)).toBeUndefined()
			expect(extractRepoFromArgs(null)).toBeUndefined()
			expect(extractRepoFromArgs('sindre-ai/maskin')).toBeUndefined()
		})

		it('returns undefined when either half is missing', () => {
			expect(extractRepoFromArgs({ owner: 'sindre-ai' })).toBeUndefined()
			expect(extractRepoFromArgs({ repo: 'maskin' })).toBeUndefined()
		})

		it('rejects values with characters the mint route would 400 on', () => {
			// The mint route's zod regex on `?repo=` is [A-Za-z0-9_.-]+ per
			// segment; anything else must not slip past the proxy.
			expect(extractRepoFromArgs({ owner: 'sindre-ai', repo: 'mask;rm' })).toBeUndefined()
			expect(extractRepoFromArgs({ owner: '../etc', repo: 'passwd' })).toBeUndefined()
			expect(extractRepoFromArgs({ owner: 'sindre ai', repo: 'maskin' })).toBeUndefined()
			expect(extractRepoFromArgs({ owner: '', repo: 'maskin' })).toBeUndefined()
		})
	})

	describe('buildMintUrl', () => {
		const base = {
			apiBaseUrl: 'http://host.docker.internal:3000',
			integrationId: '11111111-2222-3333-4444-555555555555',
			toolName: 'merge_pull_request',
		}

		it('composes tool + repo into the mint route query', () => {
			const url = buildMintUrl({ ...base, repo: 'sindre-ai/maskin' })
			const parsed = new URL(url)
			expect(parsed.pathname).toBe(`/api/integrations/${base.integrationId}/github-token`)
			expect(parsed.searchParams.get('tool')).toBe('merge_pull_request')
			expect(parsed.searchParams.get('repo')).toBe('sindre-ai/maskin')
		})

		it('omits ?repo= when the caller has no repo hint', () => {
			const url = buildMintUrl({ ...base, toolName: 'search_repositories' })
			const parsed = new URL(url)
			expect(parsed.searchParams.has('repo')).toBe(false)
			expect(parsed.searchParams.get('tool')).toBe('search_repositories')
		})

		it('throws when any required env-derived field is empty', () => {
			// Fail-loudly at the URL-building step rather than surface as a
			// mysterious 404 downstream. session-manager guarantees all three
			// on the entries it emits, so this only fires under misconfig.
			expect(() => buildMintUrl({ ...base, apiBaseUrl: '' })).toThrow(/MASKIN_API_URL/)
			expect(() => buildMintUrl({ ...base, integrationId: '' })).toThrow(/GITHUB_INTEGRATION_ID/)
			expect(() => buildMintUrl({ ...base, toolName: '' })).toThrow(/toolName/)
		})
	})

	describe('buildToolsListResponse', () => {
		it('advertises every KNOWN_TOOLS entry, and only those', () => {
			const { tools } = buildToolsListResponse()
			const advertised = tools.map((t: { name: string }) => t.name).sort()
			expect(advertised).toEqual(Object.keys(KNOWN_TOOLS).sort())
		})

		it('gives each tool a minimal input schema so Claude can call it via owner/repo', () => {
			const { tools } = buildToolsListResponse()
			for (const tool of tools as Array<{ inputSchema: { properties: Record<string, unknown> } }>) {
				expect(tool.inputSchema.properties).toHaveProperty('owner')
				expect(tool.inputSchema.properties).toHaveProperty('repo')
			}
		})
	})

	describe('buildInitializeResponse', () => {
		it('echoes the client protocol version when supplied', () => {
			const resp = buildInitializeResponse('2025-06-18')
			expect(resp.protocolVersion).toBe('2025-06-18')
			expect(resp.capabilities).toEqual({ tools: {} })
			expect(resp.serverInfo.name).toBe('maskin-github-mcp-proxy')
		})

		it('falls back to a documented default when the client omits protocolVersion', () => {
			const resp = buildInitializeResponse(undefined)
			expect(resp.protocolVersion).toBe('2024-11-05')
		})
	})

	describe('JSON-RPC line codec', () => {
		it('parses each newline-delimited JSON line and reports malformed ones', () => {
			const buf = `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n\n{"broken\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n`
			const { messages, errors } = parseJsonRpcLines(buf)
			expect(messages).toHaveLength(2)
			expect(messages[0].method).toBe('initialize')
			expect(messages[1].method).toBe('tools/list')
			expect(errors).toHaveLength(1)
			expect(errors[0].line).toBe('{"broken')
		})

		it('formats results with the JSON-RPC 2.0 envelope and a trailing newline', () => {
			const line = formatJsonRpcResult(42, { ok: true })
			expect(line.endsWith('\n')).toBe(true)
			expect(JSON.parse(line.trim())).toEqual({
				jsonrpc: '2.0',
				id: 42,
				result: { ok: true },
			})
		})

		it('formats errors with a JSON-RPC 2.0 envelope, echoing the id', () => {
			const line = formatJsonRpcError(7, -32601, 'nope')
			expect(JSON.parse(line.trim())).toEqual({
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32601, message: 'nope' },
			})
		})
	})
})

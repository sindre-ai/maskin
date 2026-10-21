import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = readFileSync(
	new URL('../../../../docker/agent-base/agent-run.sh', import.meta.url),
	'utf8',
)
const fn = script.match(/^setup_mcps\(\) \{\n[\s\S]*?^\}$/m)?.[0] ?? ''
const filter = new URL('../../../../docker/agent-base/mcp-scrub-env.jq', import.meta.url).pathname

// Stand-in values; only the variable names matter to the filter.
const CREDENTIALS = {
	MASKIN_API_KEY: 'fake-key',
	MASKIN_API_URL: 'http://fake-api',
	MASKIN_WORKSPACE_ID: 'fake-workspace',
	GITHUB_TOKEN: 'fake-gh',
	GITHUB_TOKEN_ACME: 'fake-gh-acme',
}

type Server = Record<string, unknown>

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'mcp-env-scrub-'))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

/** Runs the container's real setup_mcps and returns the config file it wrote. */
function runSetupMcps(servers: Record<string, Server>, env: Record<string, string> = {}) {
	const body = `set -eo pipefail\n${fn}\nsetup_mcps\ncat "$TMPDIR/mcp-config.json"`
	const res = spawnSync('bash', ['-c', body], {
		env: {
			PATH: process.env.PATH ?? '',
			TMPDIR: dir,
			MCP_SCRUB_ENV_FILTER: filter,
			AGENT_MCP_JSON: JSON.stringify({ mcpServers: servers }),
			...CREDENTIALS,
			...env,
		},
		encoding: 'utf8',
	})
	expect(res.status, res.stderr).toBe(0)
	const out = res.stdout.slice(res.stdout.indexOf('{'))
	const config = JSON.parse(out) as { mcpServers: Record<string, Server> }
	const server = (name: string): Server => {
		const found = config.mcpServers[name]
		if (!found) throw new Error(`no server named ${name} in the written config`)
		return found
	}
	return { raw: out, config, server }
}

const unsetNames = (server: Server) => {
	const args = server.args as string[]
	const names: string[] = []
	for (let i = 0; args[i] === '-u'; i += 2) names.push(args[i + 1] as string)
	return names
}

describe('agent-run.sh setup_mcps tool-server environment scrub', () => {
	it('is found in the script', () => {
		expect(fn).toContain('setup_mcps()')
	})

	it('unsets every credential variable an entry does not name', () => {
		const { server } = runSetupMcps({ third: { command: 'npx', args: ['-y', 'some-server'] } })
		const third = server('third')
		expect(third.command).toBe('env')
		expect(unsetNames(third).sort()).toEqual(Object.keys(CREDENTIALS).sort())
		expect(third.args).toEqual([
			...Object.keys(CREDENTIALS)
				.sort()
				.flatMap((name) => ['-u', name]),
			'--',
			'npx',
			'-y',
			'some-server',
		])
	})

	it('leaves an entry alone when none of the credential variables are set', () => {
		const res = spawnSync('jq', ['-c', '-f', filter], {
			input: '{"mcpServers":{"a":{"command":"x","args":["y"]}}}',
			env: { PATH: process.env.PATH ?? '' },
			encoding: 'utf8',
		})
		expect(JSON.parse(res.stdout).mcpServers.a).toEqual({ command: 'x', args: ['y'] })
	})

	it('keeps the variables an entry names in its env block', () => {
		const { server } = runSetupMcps({
			maskin: {
				command: 'maskin-mcp',
				env: { MASKIN_API_KEY: '${MASKIN_API_KEY}', MASKIN_WORKSPACE_ID: '${MASKIN_WORKSPACE_ID}' },
			},
		})
		const maskin = server('maskin')
		expect(unsetNames(maskin)).not.toContain('MASKIN_API_KEY')
		expect(unsetNames(maskin)).not.toContain('MASKIN_WORKSPACE_ID')
		expect(unsetNames(maskin)).toContain('MASKIN_API_URL')
		expect(unsetNames(maskin)).toContain('GITHUB_TOKEN')
		// envsubst has already put the value in the env block that stays.
		expect(maskin.env).toEqual({
			MASKIN_API_KEY: CREDENTIALS.MASKIN_API_KEY,
			MASKIN_WORKSPACE_ID: CREDENTIALS.MASKIN_WORKSPACE_ID,
		})
	})

	it('leaves http and sse entries unchanged while wrapping a stdio entry beside them', () => {
		const http = {
			type: 'http',
			url: 'http://fake-api/mcp',
			headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
		}
		const sse = { type: 'sse', url: 'http://fake-sse/events' }
		const { config, server } = runSetupMcps({ http, sse, third: { command: 'npx' } })
		expect(config.mcpServers.http).toEqual({
			type: 'http',
			url: 'http://fake-api/mcp',
			headers: { Authorization: `Bearer ${CREDENTIALS.MASKIN_API_KEY}` },
		})
		expect(config.mcpServers.sse).toEqual(sse)
		expect(server('third').command).toBe('env')
	})

	it('wraps an entry that has no env block and no args', () => {
		const { server } = runSetupMcps({ bare: { command: 'github-mcp-server' } })
		const bare = server('bare')
		expect(bare.command).toBe('env')
		expect((bare.args as string[]).slice(-2)).toEqual(['--', 'github-mcp-server'])
		expect(bare.env).toBeUndefined()
	})

	it('passes arguments with spaces and quotes through to the launched process', () => {
		const tricky = ['a b', `it's`, 'say "hi"', '--flag=x y', '-u']
		const { server } = runSetupMcps({ echo: { command: 'printf', args: ['%s\\n', ...tricky] } })
		const echo = server('echo')
		const run = spawnSync(echo.command as string, echo.args as string[], {
			env: { PATH: process.env.PATH ?? '', ...CREDENTIALS },
			encoding: 'utf8',
		})
		expect(run.stdout).toBe(`${tricky.join('\n')}\n`)
	})

	it('starts a tool server that cannot see credentials it does not name', () => {
		const { server } = runSetupMcps({
			third: { command: 'bash', args: ['-c', 'env | cut -d= -f1 | sort'] },
			named: {
				command: 'bash',
				args: ['-c', 'env | cut -d= -f1 | sort'],
				env: { MASKIN_API_KEY: '${MASKIN_API_KEY}' },
			},
		})
		const names = (server: Server) => {
			// Claude Code starts the child with its own environment plus the entry's env block.
			const run = spawnSync(server.command as string, server.args as string[], {
				env: { PATH: process.env.PATH ?? '', ...CREDENTIALS, ...(server.env as object) },
				encoding: 'utf8',
			})
			return run.stdout.split('\n')
		}
		const third = names(server('third'))
		for (const name of Object.keys(CREDENTIALS)) expect(third).not.toContain(name)
		const named = names(server('named'))
		expect(named).toContain('MASKIN_API_KEY')
		expect(named).not.toContain('MASKIN_API_URL')
		expect(named).not.toContain('GITHUB_TOKEN_ACME')
	})

	it('writes byte-identical output with MASKIN_MCP_ENV_SCRUB=off', () => {
		const servers = {
			third: { command: 'npx', args: ['-y', 'x y'], env: { A: '${MASKIN_API_URL}' } },
			http: { type: 'http', url: 'http://fake-api/mcp' },
		}
		const off = runSetupMcps(servers, { MASKIN_MCP_ENV_SCRUB: 'off' })
		// What setup_mcps wrote before the scrub existed: merge, then envsubst.
		const merge = '{ mcpServers: ((.[0].mcpServers // {}) * (.[1].mcpServers // {})) }'
		const before = spawnSync(
			'bash',
			['-c', `printf '%s\\n%s' "$AGENT_MCP_JSON" '{}' | jq -s '${merge}' | envsubst`],
			{
				env: {
					PATH: process.env.PATH ?? '',
					AGENT_MCP_JSON: JSON.stringify({ mcpServers: servers }),
					...CREDENTIALS,
				},
				encoding: 'utf8',
			},
		)
		expect(off.raw).toBe(before.stdout)
		// And the default really does differ, so the comparison is not vacuous.
		expect(runSetupMcps(servers).raw).not.toBe(before.stdout)
	})

	it('does not abort the script when the filter file is missing', () => {
		const res = spawnSync('bash', ['-c', `set -eo pipefail\n${fn}\nsetup_mcps\necho survived`], {
			env: {
				PATH: process.env.PATH ?? '',
				TMPDIR: dir,
				MCP_SCRUB_ENV_FILTER: join(dir, 'missing.jq'),
				AGENT_MCP_JSON: JSON.stringify({ mcpServers: { a: { command: 'x' } } }),
			},
			encoding: 'utf8',
		})
		expect(res.stdout).toContain('survived')
		expect(res.stderr).toContain('missing')
	})
})

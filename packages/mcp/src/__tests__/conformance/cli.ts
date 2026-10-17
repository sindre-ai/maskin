// Runs the conformance matrix against a RUNNING server over HTTP.
//
//   pnpm --filter @maskin/mcp conformance \
//     --base-url http://localhost:3000 --api-key ank_... --workspace-id <uuid> \
//     --flag on [--strict] [--response-cap-tokens 300] [--digest-file /tmp/tools-digest] \
//     [--rows id,id] [--transcript]
//
// Exit code 1 if any row fails (and, with --strict, if any row is pending).

import { ROWS } from './rows'
import { runMatrix } from './runner'
import type { FlagState, Row, RowResult, RunEnv, Target } from './types'
import { MODERN_VERSION, legacyInitialize, legacyRequest, post, postModern } from './wire'

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? undefined : process.argv[i + 1]
}

function required(name: string): string {
	const value = arg(name) ?? process.env[name.toUpperCase().replace(/-/g, '_')]
	if (!value) {
		console.error(`missing --${name}`)
		process.exit(2)
	}
	return value
}

const flag = (arg('flag') ?? 'on') as FlagState
if (flag !== 'on' && flag !== 'off') {
	console.error('--flag must be on or off')
	process.exit(2)
}

const target: Target = {
	baseUrl: required('base-url'),
	apiKey: required('api-key'),
	workspaceId: required('workspace-id'),
	webAppOrigin: arg('web-app-origin') ?? 'https://maskin.io',
}
const env: RunEnv = {
	flag,
	strict: process.argv.includes('--strict'),
	responseCapTokens: arg('response-cap-tokens') ? Number(arg('response-cap-tokens')) : undefined,
	digestFile: arg('digest-file'),
}
const only = arg('rows')?.split(',')
const rows: readonly Row[] = only ? ROWS.filter((r) => only.includes(r.id)) : ROWS

const SYMBOL = { pass: 'PASS', fail: 'FAIL', pending: 'PEND', 'n/a': 'n/a ' } as const

function print(results: RowResult[]) {
	for (const r of results) {
		const detail = r.detail ? `  ${r.detail.split('\n')[0].slice(0, 160)}` : ''
		console.log(`${SYMBOL[r.status]}  ${r.rowId.padEnd(34)} ${r.style.padEnd(11)}${detail}`)
	}
	const count = (s: RowResult['status']) => results.filter((r) => r.status === s).length
	console.log(
		`\n${count('pass')} passed, ${count('fail')} failed, ${count('pending')} pending, ${count('n/a')} n/a`,
	)
}

/** The handshake transcripts the PR body quotes: a legacy handshake plus tools, and server/discover. */
async function transcript() {
	const show = (label: string, o: { status: number; contentType: string | null; text: string }) =>
		console.log(
			`\n### ${label}\nHTTP ${o.status} ${o.contentType ?? ''}\n${o.text.slice(0, 600)}${o.text.length > 600 ? ' ...(truncated)' : ''}`,
		)
	show('legacy initialize', await post(target, legacyInitialize()))
	const tools = await post(target, legacyRequest('tools/list'))
	show(`legacy tools/list (${tools.text.length} bytes)`, tools)
	show(
		`modern server/discover (version ${MODERN_VERSION})`,
		await postModern(target, 'server/discover'),
	)
}

const { features, results } = await runMatrix(rows, target, env)
console.log(`flag ${env.flag}; features detected: ${[...features].sort().join(', ') || 'none'}\n`)
print(results)
if (process.argv.includes('--transcript')) await transcript()
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0)

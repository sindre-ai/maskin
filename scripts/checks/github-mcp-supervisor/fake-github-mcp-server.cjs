// Stand-in for github-mcp-server stdio, used by github-mcp-supervisor.test.cjs.
//
// Answers a tool call that needs auth with GitHub's 401 error shape unless it
// was started with the token the test calls valid (FAKE_VALID_TOKEN). The
// tokens in the tests are made-up strings.
//
// Tools: get_me and list_branches (need auth), echo, slow, stats, forbidden,
// mentions_401 (a successful result whose text mentions 401), issue_401_not_found
// (a 404 error whose URL contains 401), crash.
// Any other method with an id is answered with { discovered: true }.

const readline = require('node:readline')

const startedWith = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || ''
const authorised = startedWith !== '' && startedWith === process.env.FAKE_VALID_TOKEN
let initializeCount = 0
let initializedCount = 0
let authCalls = 0

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function text(value, isError) {
	const result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
	if (isError) result.isError = true
	return result
}

function errorText(value) {
	return { isError: true, content: [{ type: 'text', text: value }] }
}

function handleTool(id, name, args) {
	if (name === 'get_me' || name === 'list_branches') {
		authCalls += 1
		if (authorised) reply(id, text({ ok: true, pid: process.pid, tag: args.tag }))
		else
			reply(
				id,
				errorText('failed to get user: GET https://api.github.com/user: 401 Bad credentials []'),
			)
	} else if (name === 'echo') {
		reply(id, text({ pid: process.pid, tag: args.tag }))
	} else if (name === 'slow') {
		setTimeout(() => reply(id, text({ pid: process.pid, tag: args.tag })), args.ms || 50)
	} else if (name === 'forbidden') {
		reply(
			id,
			errorText(
				'GET https://api.github.com/repos/x/y: 403 Resource not accessible by integration []',
			),
		)
	} else if (name === 'issue_401_not_found') {
		reply(
			id,
			errorText(
				'failed to get issue: GET https://api.github.com/repos/x/y/issues/401: 404 Not Found []',
			),
		)
	} else if (name === 'mentions_401') {
		reply(id, text({ note: 'docs: a 401 Bad credentials error means the token expired' }))
	} else if (name === 'stats') {
		const maskinKeys = Object.keys(process.env).filter((key) => key.startsWith('MASKIN_'))
		reply(
			id,
			text({
				pid: process.pid,
				initializeCount,
				initializedCount,
				authCalls,
				argv: process.argv.slice(2),
				maskinKeys,
				hasGithubToken: startedWith !== '',
			}),
		)
	} else if (name === 'crash') {
		process.exit(3)
	} else {
		reply(id, errorText(`unknown tool ${name}`))
	}
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.method === 'initialize') {
		initializeCount += 1
		reply(message.id, {
			protocolVersion: '2025-06-18',
			serverInfo: { name: 'fake-github-mcp-server' },
		})
	} else if (message.method === 'notifications/initialized') {
		initializedCount += 1
	} else if (message.method === 'tools/call') {
		handleTool(message.id, message.params.name, message.params.arguments || {})
	} else if (message.id !== undefined && message.method) {
		reply(message.id, { discovered: true })
	}
})
lines.on('close', () => process.exit(0))

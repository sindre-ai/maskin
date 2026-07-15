import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

function loadEnv() {
	try {
		const env = readFileSync('.env', 'utf-8')
		for (const line of env.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const idx = trimmed.indexOf('=')
			if (idx === -1) continue
			const key = trimmed.slice(0, idx)
			const value = trimmed.slice(idx + 1)
			if (!(key in process.env)) {
				process.env[key] = value
			}
		}
	} catch {}
}

loadEnv()

function run(cmd) {
	console.log(`> ${cmd}`)
	execSync(cmd, { stdio: 'inherit', env: process.env })
}

// Ensure integration encryption key exists in .env before servers start.
// --skip-db-default: this stack has no local Docker Postgres to fall back to,
// so a missing DATABASE_URL (e.g. a Supabase connection string) must fail fast
// instead of silently writing the localhost default.
run('node scripts/ensure-encryption-key.mjs --skip-db-default')
loadEnv()

// Run migrations
run('pnpm db:migrate')

// Start dev servers
console.log('Starting dev servers...')
const child = spawn('pnpm', ['turbo', 'dev', '--log-prefix=none'], {
	stdio: 'inherit',
	shell: true,
	env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))

import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Load .env into process.env
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

function run(cmd) {
	console.log(`> ${cmd}`)
	execSync(cmd, { stdio: 'inherit', env: process.env })
}

// Start docker services
run('docker-compose up -d postgres seaweedfs')

// Wait for postgres
console.log('Waiting for PostgreSQL to be ready...')
for (let i = 0; i < 30; i++) {
	try {
		execSync('docker-compose exec -T postgres pg_isready -U postgres', {
			stdio: 'ignore',
		})
		break
	} catch {
		if (i === 29) {
			console.error('PostgreSQL did not become ready in time')
			process.exit(1)
		}
		execSync('node -e "setTimeout(()=>{},1000)"')
	}
}
console.log('PostgreSQL is ready.')

// Ensure SeaweedFS S3 bucket exists
console.log('Ensuring S3 bucket exists...')
for (let i = 0; i < 10; i++) {
	try {
		execSync(
			'curl -s --aws-sigv4 "aws:amz:us-east-1:s3" --user "admin:admin" -X PUT http://localhost:8334/agent-files',
			{ stdio: 'ignore' },
		)
		break
	} catch {
		if (i === 9) {
			console.warn('Warning: Could not create S3 bucket, SeaweedFS may not be ready')
		}
		execSync('node -e "setTimeout(()=>{},1000)"')
	}
}

// Build agent-base Docker image
console.log('Building agent-base Docker image...')
try {
	execSync('docker build -t agent-base:latest docker/agent-base', { stdio: 'inherit' })
} catch {
	console.warn('Warning: Failed to build agent-base image')
}

// Run migrations
run('pnpm db:migrate')

// Start dev servers
console.log('Starting dev servers...')
const child = spawn('pnpm', ['turbo', 'dev'], {
	stdio: 'inherit',
	shell: true,
	env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))

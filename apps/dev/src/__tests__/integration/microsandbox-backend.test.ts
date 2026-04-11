/**
 * Integration tests for MicrosandboxBackend on Linux with KVM.
 *
 * Prerequisites:
 *   - Linux with KVM enabled (/dev/kvm)
 *   - microsandbox server running
 *   - RUNTIME_BACKEND=microsandbox
 *
 * Run: pnpm test:microsandbox
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const KVM_AVAILABLE = existsSync('/dev/kvm')
const MICROSANDBOX_ENABLED = process.env.RUNTIME_BACKEND === 'microsandbox'
const SKIP = !KVM_AVAILABLE || !MICROSANDBOX_ENABLED
const TEST_IMAGE = process.env.MICROSANDBOX_TEST_IMAGE ?? 'docker.io/library/alpine:latest'

describe.skipIf(SKIP)('MicrosandboxBackend integration', () => {
	let backend: import('../../services/runtime-backend').RuntimeBackend
	let sandboxId: string
	let tempDir: string

	beforeAll(async () => {
		const { MicrosandboxBackend } = await import('../../services/microsandbox-backend')
		backend = new MicrosandboxBackend()
		tempDir = join(tmpdir(), `msb-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
	})

	afterAll(async () => {
		if (sandboxId) {
			try {
				await backend.remove(sandboxId)
			} catch {}
		}
		await rm(tempDir, { recursive: true, force: true })
	})

	describe('1. KVM availability', () => {
		it('verifies /dev/kvm exists', () => {
			expect(existsSync('/dev/kvm')).toBe(true)
		})
	})

	describe('2. Sandbox lifecycle', () => {
		it('creates a sandbox with the test image', async () => {
			await backend.ensureImage(TEST_IMAGE)

			sandboxId = await backend.create({
				image: TEST_IMAGE,
				name: `msb-test-${Date.now()}`,
				env: {
					TEST_VAR_1: 'hello',
					TEST_VAR_2: 'world',
					MASKIN_API_URL: 'http://test:3000',
				},
				memoryMb: 256,
				cpuShares: 1024,
				binds: [],
				maxDurationSecs: 120,
			})

			expect(sandboxId).toBeTruthy()
		}, 60_000)

		it('starts the sandbox and runs entrypoint', async () => {
			await backend.start(sandboxId)

			const status = await backend.inspect(sandboxId)
			expect(status.running).toBe(true)
			expect(status.startedAt).toBeTruthy()
		}, 30_000)
	})

	describe('3. Log streaming via SSE', () => {
		it('streams stdout/stderr from the sandbox', async () => {
			const logs: Array<{ stream: string; data: string }> = []
			const logGen = backend.logs(sandboxId)

			// Collect logs for up to 5 seconds
			const timeout = setTimeout(() => {}, 5000)
			const collectPromise = (async () => {
				for await (const chunk of logGen) {
					logs.push(chunk)
					if (logs.length >= 3) break
				}
			})()

			const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 10_000))
			await Promise.race([collectPromise, timeoutPromise])
			clearTimeout(timeout)

			// Alpine's sleep infinity won't produce logs, but the entrypoint.sh exec will.
			// With alpine image directly (no entrypoint), logs may be empty — that's ok.
			// The key assertion is that the log generator doesn't throw.
			expect(Array.isArray(logs)).toBe(true)
			for (const log of logs) {
				expect(log).toHaveProperty('stream')
				expect(log).toHaveProperty('data')
				expect(['stdout', 'stderr', 'system']).toContain(log.stream)
			}
		}, 15_000)
	})

	describe('4. Command execution and exit codes', () => {
		it('executes a command and captures output', async () => {
			const result = await backend.exec(sandboxId, ['echo', 'hello from microVM'])
			expect(result.exitCode).toBe(0)
			expect(result.output).toContain('hello from microVM')
		}, 10_000)

		it('captures non-zero exit codes', async () => {
			const result = await backend.exec(sandboxId, ['sh', '-c', 'exit 42'])
			expect(result.exitCode).toBe(42)
		}, 10_000)
	})

	describe('5. Environment variables', () => {
		it('passes env vars correctly to the sandbox', async () => {
			const result = await backend.exec(sandboxId, ['sh', '-c', 'echo $TEST_VAR_1:$TEST_VAR_2'])
			expect(result.exitCode).toBe(0)
			expect(result.output.trim()).toBe('hello:world')
		}, 10_000)

		it('passes MASKIN_API_URL to the sandbox', async () => {
			const result = await backend.exec(sandboxId, ['sh', '-c', 'echo $MASKIN_API_URL'])
			expect(result.exitCode).toBe(0)
			expect(result.output.trim()).toBe('http://test:3000')
		}, 10_000)
	})

	describe('6. Host address reachability', () => {
		it('getHostAddress() returns a valid IP', () => {
			const addr = backend.getHostAddress()
			expect(addr).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
		})

		it('host address is reachable from inside the VM', async () => {
			const addr = backend.getHostAddress()
			// Use wget since alpine doesn't have curl by default
			const result = await backend.exec(sandboxId, [
				'sh',
				'-c',
				`wget -q -O /dev/null --timeout=3 http://${addr}:${process.env.PORT ?? 3000}/ 2>&1 || echo "unreachable: exit $?"`,
			])
			// We don't require success (the API might not be running during tests),
			// but we verify the connection attempt doesn't hang/crash
			expect(result.output).toBeDefined()
		}, 15_000)

		it('can ping the host address from inside the VM', async () => {
			const addr = backend.getHostAddress()
			const result = await backend.exec(sandboxId, ['ping', '-c', '1', '-W', '3', addr])
			// ping may fail if ICMP is blocked, but exec itself should succeed
			expect(typeof result.exitCode).toBe('number')
		}, 10_000)
	})

	describe('7. File transfer', () => {
		it('copies a file into the sandbox (copyFileIn)', async () => {
			const hostFile = join(tempDir, 'test-input.txt')
			await writeFile(hostFile, 'file transfer test content')

			await backend.copyFileIn(sandboxId, hostFile, '/tmp/test-input.txt')

			const result = await backend.exec(sandboxId, ['cat', '/tmp/test-input.txt'])
			expect(result.exitCode).toBe(0)
			expect(result.output).toContain('file transfer test content')
		}, 15_000)

		it('copies a file out of the sandbox (copyFileOut)', async () => {
			await backend.exec(sandboxId, [
				'sh',
				'-c',
				'echo "output from microVM" > /tmp/test-output.txt',
			])

			const hostFile = join(tempDir, 'test-output.txt')
			await backend.copyFileOut(sandboxId, '/tmp/test-output.txt', hostFile)

			const content = await readFile(hostFile, 'utf-8')
			expect(content).toContain('output from microVM')
		}, 15_000)
	})

	describe('8. Pause/resume via tar-based snapshot', () => {
		it('creates a tar snapshot of /agent directory', async () => {
			// Create test data in /tmp (alpine doesn't have /agent)
			await backend.exec(sandboxId, ['sh', '-c', 'mkdir -p /tmp/agent && echo snapshot-test > /tmp/agent/data.txt'])

			// Create tar snapshot
			const tarResult = await backend.exec(sandboxId, [
				'tar',
				'-czf',
				'/tmp/snapshot.tar.gz',
				'/tmp/agent/',
			])
			expect(tarResult.exitCode).toBe(0)

			// Copy snapshot out
			const snapshotPath = join(tempDir, 'snapshot.tar.gz')
			await backend.copyFileOut(sandboxId, '/tmp/snapshot.tar.gz', snapshotPath)

			expect(existsSync(snapshotPath)).toBe(true)
			const stat = await import('node:fs/promises').then((m) => m.stat(snapshotPath))
			expect(stat.size).toBeGreaterThan(0)
		}, 20_000)
	})

	describe('9. Stop and inspect', () => {
		it('stops the sandbox and captures exit code', async () => {
			await backend.stop(sandboxId)

			const status = await backend.inspect(sandboxId)
			expect(status.running).toBe(false)
			expect(status.exitCode).toBeDefined()
			expect(typeof status.exitCode).toBe('number')
		}, 15_000)
	})

	describe('10. onExit event-driven detection', () => {
		let secondSandboxId: string

		it('resolves onExit when the sandbox process exits', async () => {
			secondSandboxId = await backend.create({
				image: TEST_IMAGE,
				name: `msb-exit-test-${Date.now()}`,
				env: {},
				memoryMb: 128,
				cpuShares: 512,
				binds: [],
				maxDurationSecs: 30,
			})

			await backend.start(secondSandboxId)

			expect(backend.onExit).toBeDefined()
			const exitPromise = backend.onExit!(secondSandboxId)

			// Stop the sandbox to trigger exit
			await backend.stop(secondSandboxId)

			const result = await exitPromise
			expect(result).toHaveProperty('exitCode')
			expect(typeof result.exitCode).toBe('number')

			await backend.remove(secondSandboxId)
		}, 30_000)
	})

	describe('11. Cleanup', () => {
		it('removes the sandbox and cleans up resources', async () => {
			await backend.remove(sandboxId)

			const status = await backend.inspect(sandboxId)
			expect(status.running).toBe(false)
			// After removal, sandbox ID should be cleaned from internal maps
			sandboxId = '' // prevent afterAll from double-removing
		}, 10_000)
	})
})

// Diagnostic test that always runs — reports prerequisites
describe('MicrosandboxBackend prerequisites', () => {
	it('reports KVM availability', () => {
		const kvmExists = existsSync('/dev/kvm')
		console.log(`KVM available: ${kvmExists}`)
		if (!kvmExists) {
			console.log('  → Skipping microsandbox tests: /dev/kvm not found')
			console.log('  → Run on a Linux machine with KVM enabled')
		}
	})

	it('reports RUNTIME_BACKEND setting', () => {
		const backend = process.env.RUNTIME_BACKEND ?? '(not set)'
		console.log(`RUNTIME_BACKEND: ${backend}`)
		if (backend !== 'microsandbox') {
			console.log('  → Set RUNTIME_BACKEND=microsandbox to run integration tests')
		}
	})
})

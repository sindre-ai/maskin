import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const MSB_BIN = process.env.MSB_BIN ?? '/root/.microsandbox/bin/msb'

// Sandbox name validation is the same shape we accept for sessionId on the
// HTTP boundary — matches T8's `SESSION_ID_RE` (`session-workspace.ts`) so
// `sandboxName === sessionId` is a safe assumption inside agent-server.
const SANDBOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function assertValidName(name: string): void {
	if (!SANDBOX_NAME_RE.test(name)) {
		throw new Error(`Invalid sandbox name: ${JSON.stringify(name)}`)
	}
}

export type MsbCreateOptions = {
	name: string
	image: string
	memoryMib: number
	cpus: number
	env: Record<string, string>
	volumes: Array<{ host: string; guest: string }>
	maxDurationSecs?: number
}

export type MsbListEntry = {
	name: string
	status: string
}

export interface MsbCli {
	// `msb create --replace` — creates (and replaces) a sandbox by name.
	// In v1 we use this both for fresh sessions and for restore, since the
	// disk-only snapshot model means restore = boot a fresh microVM whose
	// `/agent` bind-mount has been pre-extracted from the snapshot tarball.
	create(options: MsbCreateOptions): Promise<void>
	// `msb remove -f` — stop + remove atomically. Used by T3's stop endpoint.
	remove(name: string): Promise<void>
	// `msb list --format json` — enumerate every sandbox the host knows about.
	list(): Promise<MsbListEntry[]>
}

export class MsbCliImpl implements MsbCli {
	private readonly bin: string

	constructor(bin: string = MSB_BIN) {
		this.bin = bin
	}

	async create(options: MsbCreateOptions): Promise<void> {
		assertValidName(options.name)
		const args = [
			'create',
			'--name',
			options.name,
			'--memory',
			`${options.memoryMib}M`,
			'--cpus',
			String(options.cpus),
			'--replace',
			'--quiet',
		]
		for (const [key, value] of Object.entries(options.env)) {
			args.push('-e', `${key}=${value}`)
		}
		for (const v of options.volumes) {
			args.push('-v', `${v.host}:${v.guest}`)
		}
		if (options.maxDurationSecs !== undefined) {
			args.push('--max-duration', `${options.maxDurationSecs}s`)
		}
		args.push(options.image)
		await execFile(this.bin, args, { timeout: 60_000 })
	}

	async remove(name: string): Promise<void> {
		assertValidName(name)
		await execFile(this.bin, ['remove', '-f', '--quiet', name], { timeout: 30_000 })
	}

	async list(): Promise<MsbListEntry[]> {
		const { stdout } = await execFile(this.bin, ['list', '--format', 'json'], {
			timeout: 10_000,
		})
		const parsed = JSON.parse(stdout)
		if (!Array.isArray(parsed)) return []
		return parsed
			.filter((row): row is { name: string; status: string } => {
				return (
					typeof row === 'object' &&
					row !== null &&
					typeof (row as Record<string, unknown>).name === 'string' &&
					typeof (row as Record<string, unknown>).status === 'string'
				)
			})
			.map((row) => ({ name: row.name, status: row.status }))
	}
}

import { z } from 'zod'

const envSchema = z.object({
	PORT: z
		.string()
		.optional()
		.default('3001')
		.transform((v) => {
			const n = Number(v)
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid PORT: ${v}`)
			}
			return n
		}),
	AGENT_SERVER_SECRET: z
		.string()
		.min(
			16,
			'AGENT_SERVER_SECRET must be at least 16 chars (generate with `openssl rand -hex 32`)',
		),
	MSB_BIN: z.string().optional().default('/root/.microsandbox/bin/msb'),
	MASKIN_AGENT_SERVER_PUBLIC_HOST: z.string().optional(),
	// Hostname the microVM uses to reach this agent-server over the host loopback.
	// microsandbox writes `host.microsandbox.internal` into /etc/hosts of each VM;
	// override only when deploying on a different hypervisor or custom network setup.
	AGENT_SERVER_INTERNAL_HOST: z.string().optional(),
	AGENT_SESSION_ROOT: z.string().optional().default('/agent/sessions'),
	// Hard cap on a session microVM's lifetime, passed to `msb create --max-duration`.
	// A `create`d sandbox is persistent: microsandbox does NOT power it off when its
	// entrypoint exits (the guest's PID 1 is msb's agentd, not agent-run.sh). The
	// normal teardown is agent-run.sh POSTing /sessions/:id/complete, which stops the
	// VM. This duration is the backstop for a VM that wedges or whose agent dies before
	// signalling, so it can't sit "running" forever. msb duration syntax (e.g. 30s,
	// 5m, 8h). Empty or `0` disables the cap.
	SESSION_MAX_DURATION: z
		.string()
		.optional()
		.default('8h')
		.refine((v) => v === '' || v === '0' || /^\d+(ms|s|m|h)$/.test(v), {
			message: 'SESSION_MAX_DURATION must be empty, 0, or msb duration syntax (e.g. 30s, 5m, 8h)',
		}),
	S3_ENDPOINT: z.string().optional(),
	S3_BUCKET: z.string().optional(),
	S3_ACCESS_KEY: z.string().optional(),
	S3_SECRET_KEY: z.string().optional(),
	S3_REGION: z.string().optional().default('us-east-1'),
	// Maskin backend base URL for log-ingest and session-complete callbacks.
	// When set, monitorSession streams msb logs back to the backend so the UI
	// can show live output. Example: https://maskin.io
	MASKIN_BASE_URL: z.string().url().optional(),
	// Image to keep present in libkrun's host cache so session spawns can skip
	// the network pull. Unset disables warming entirely.
	WARM_POOL_IMAGE: z.string().optional(),
	// Chromium sidecar image used for browser-enabled sessions. Set this to the
	// same repository/tag published by the browser-sidecar Docker workflow.
	BROWSER_SIDECAR_IMAGE: z.string().optional().default('browser-sidecar:latest'),
	// Minutes between cache re-warms. 0 warms once at startup only (zero ongoing
	// overhead); a positive value lets a moving `:latest` reach sessions without
	// a restart. Bounded so a typo can't schedule a sub-second pull loop.
	WARM_POOL_REFRESH_MINUTES: z
		.string()
		.optional()
		.default('0')
		.transform((v) => {
			const n = Number(v)
			if (!Number.isInteger(n) || n < 0 || n > 1440) {
				throw new Error(`Invalid WARM_POOL_REFRESH_MINUTES: ${v} (expected integer 0..1440)`)
			}
			return n
		}),
})

export type AgentServerEnv = z.infer<typeof envSchema>

export function parseEnv(source: NodeJS.ProcessEnv = process.env): AgentServerEnv {
	return envSchema.parse(source)
}

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
	AGENT_SESSION_ROOT: z.string().optional().default('/agent/sessions'),
	S3_ENDPOINT: z.string().optional(),
	S3_BUCKET: z.string().optional(),
	S3_ACCESS_KEY: z.string().optional(),
	S3_SECRET_KEY: z.string().optional(),
	S3_REGION: z.string().optional().default('us-east-1'),
	WARM_POOL_IMAGE: z.string().optional(),
	WARM_POOL_SIZE: z
		.string()
		.optional()
		.default('5')
		.transform((v) => {
			const n = Number(v)
			if (!Number.isFinite(n) || n < 0 || n > 50) {
				throw new Error(`Invalid WARM_POOL_SIZE: ${v} (expected integer 0..50)`)
			}
			return Math.floor(n)
		}),
})

export type AgentServerEnv = z.infer<typeof envSchema>

export function parseEnv(source: NodeJS.ProcessEnv = process.env): AgentServerEnv {
	return envSchema.parse(source)
}

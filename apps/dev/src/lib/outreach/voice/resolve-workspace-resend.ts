import type { Database } from '@maskin/db'
import { Resend } from '@maskin/email'
import { getIntegrationCredential } from '../../integrations/lookup'
import { TokenManager } from '../../integrations/oauth/token-manager'
import { getProvider } from '../../integrations/registry'

// The slice of integrations.config.resend this resolver reads. verification_status
// and receive_subdomain are written by the connect flow and the domain verifier;
// send_from is read-only here.
interface ResendSendConfig {
	send_from?: string
	receive_subdomain?: string
	verification_status?: 'pending' | 'verified' | 'failed'
}

export interface WorkspaceResend {
	resend: Resend
	from: string
}

// Used when config.resend.send_from is unset: the integration's own verified
// domain, which is the only one Resend will accept as a sender.
const DEFAULT_SEND_LOCAL_PART = 'noreply'

function resolveFrom(config: ResendSendConfig | undefined): string | null {
	if (config?.send_from) return config.send_from
	if (config?.verification_status === 'verified' && config.receive_subdomain) {
		return `${DEFAULT_SEND_LOCAL_PART}@${config.receive_subdomain}`
	}
	return null
}

/**
 * Resolves the workspace's own Resend client and sender for agent-driven
 * sends that run in the API process (no session container, so the
 * session-manager env injection never applies).
 *
 * Returns null when the workspace has no active resend integration, or when
 * it has no usable sender (no send_from and no verified domain yet). The
 * caller logs and skips; this never throws for a missing integration.
 */
export async function resolveWorkspaceResend(
	db: Database,
	workspaceId: string,
): Promise<WorkspaceResend | null> {
	// getIntegrationCredential only returns status = 'active' rows, so "no
	// integration" and "not active" are the same miss.
	const integration = await getIntegrationCredential(db, workspaceId, 'resend', null)
	if (!integration) return null

	const from = resolveFrom((integration.config as { resend?: ResendSendConfig }).resend)
	if (!from) return null

	const accessToken = await new TokenManager().getValidToken(
		db,
		integration.id,
		getProvider('resend'),
	)
	return { resend: new Resend(accessToken), from }
}

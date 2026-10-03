import {
	type KmsProvider,
	LocalFileKmsProvider,
	createKmsProvider,
	resolveKeychainEnv,
	resolveKeychainKmsKind,
} from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { logger } from './logger'

let provider: KmsProvider | undefined

/** The process-wide KMS provider, chosen once by KEYCHAIN_KMS. */
export function getKmsProvider(db: Database): KmsProvider {
	provider ??= createKmsProvider(db)
	return provider
}

/**
 * Called once at boot. An unknown KEYCHAIN_KMS value throws, so the process
 * fails to start, and so does aws-kms with KEYCHAIN_ENV unset or unknown. Unset is allowed here (nothing reads KMS until the first
 * envelope write), and warned about in production, where reading it later
 * would throw.
 */
export function assertKeychainKmsConfig(
	env: Record<string, string | undefined> = process.env,
): void {
	if (!env.KEYCHAIN_KMS?.trim()) {
		if (env.NODE_ENV === 'production') {
			logger.warn(
				'KEYCHAIN_KMS is not set: Keychain envelope encryption is unavailable until it is',
			)
		}
		return
	}
	if (resolveKeychainKmsKind(env) === 'aws-kms') resolveKeychainEnv(env)
}

/**
 * Called once at boot, after the env check. In production under local-file it
 * creates the KEK file now (so the one-time off-volume copy has something to
 * copy right after the first deploy) and logs whether the file existed plus a
 * short fingerprint, so a redeploy can be compared by log line. If the file is
 * missing while wrapped credentials exist, the provider refuses to make a new
 * KEK; that is logged as an error and boot continues, since legacy credentials
 * and everything else still work. The next envelope use throws the same error.
 */
export async function prepareLocalKek(db: Database): Promise<void> {
	if (process.env.NODE_ENV !== 'production' || resolveKeychainKmsKind() !== 'local-file') return
	const kms = getKmsProvider(db)
	if (!(kms instanceof LocalFileKmsProvider)) return
	try {
		const { existed, fingerprint } = await kms.prepare()
		logger.info('Keychain KEK (local-file)', {
			kekFileExisted: existed,
			kekFingerprint: fingerprint,
		})
	} catch (err) {
		logger.error('Keychain KEK (local-file) is not available', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** For tests. */
export function setKmsProviderForTests(next: KmsProvider | undefined): void {
	provider = next
}

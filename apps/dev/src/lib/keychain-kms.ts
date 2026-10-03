import {
	type KmsProvider,
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

/** For tests. */
export function setKmsProviderForTests(next: KmsProvider | undefined): void {
	provider = next
}

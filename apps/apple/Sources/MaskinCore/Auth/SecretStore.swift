import Foundation
import Security

/// Where the signed-in session lives. The Keychain in production; in memory in tests.
public protocol SecretStore: Sendable {
	func read() throws -> Data?
	func write(_ data: Data) throws
	func delete() throws
}

public struct KeychainError: Error, Equatable {
	public let status: OSStatus
}

/// One generic-password item. `accessGroup` lets the iOS app, the watch app and the Mac app read
/// the same session once they share a keychain access group in their entitlements.
public struct KeychainSecretStore: SecretStore {
	public let service: String
	public let account: String
	public let accessGroup: String?

	public init(
		service: String = "io.maskin.app", account: String = "session", accessGroup: String? = nil
	) {
		self.service = service
		self.account = account
		self.accessGroup = accessGroup
	}

	private func query(dataProtection: Bool) -> [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
		#if os(macOS)
			// The data-protection keychain is the iOS-style one (honours kSecAttrAccessible, no
			// per-app ACL prompts). It needs a signed build with keychain entitlements; an unsigned
			// dev build gets errSecMissingEntitlement, handled by `run` below.
			if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
		#endif
		return q
	}

	/// Runs a Keychain operation against the data-protection keychain on macOS, falling back to
	/// the legacy file keychain when the build is unsigned (errSecMissingEntitlement, -34018).
	private func run(_ op: (_ dataProtection: Bool) -> OSStatus) -> OSStatus {
		let status = op(true)
		#if os(macOS)
			if status == errSecMissingEntitlement { return op(false) }
		#endif
		return status
	}

	public func read() throws -> Data? {
		var item: CFTypeRef?
		let status = run { dp in
			var q = query(dataProtection: dp)
			q[kSecReturnData as String] = true
			q[kSecMatchLimit as String] = kSecMatchLimitOne
			item = nil
			return SecItemCopyMatching(q as CFDictionary, &item)
		}
		if status == errSecItemNotFound { return nil }
		guard status == errSecSuccess else { throw KeychainError(status: status) }
		return item as? Data
	}

	public func write(_ data: Data) throws {
		let status = run { dp in
			var status = SecItemUpdate(
				query(dataProtection: dp) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
			if status == errSecItemNotFound {
				var add = query(dataProtection: dp)
				add[kSecValueData as String] = data
				// After first unlock, so a push-triggered background fetch can still authenticate;
				// ThisDeviceOnly keeps the key out of backups and device-to-device migration. Revisit
				// only if a shared access group ever needs the session to sync (it does not today).
				add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
				status = SecItemAdd(add as CFDictionary, nil)
			}
			return status
		}
		guard status == errSecSuccess else { throw KeychainError(status: status) }
	}

	public func delete() throws {
		let status = run { SecItemDelete(query(dataProtection: $0) as CFDictionary) }
		guard status == errSecSuccess || status == errSecItemNotFound else {
			throw KeychainError(status: status)
		}
	}
}

public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
	private let lock = NSLock()
	private var data: Data?

	public init(_ data: Data? = nil) { self.data = data }

	public func read() throws -> Data? { lock.withLock { data } }
	public func write(_ data: Data) throws { lock.withLock { self.data = data } }
	public func delete() throws { lock.withLock { data = nil } }
}

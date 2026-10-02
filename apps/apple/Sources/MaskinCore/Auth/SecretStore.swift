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

	/// Which keychain this process uses, decided ONCE so read/write/delete never straddle two
	/// stores. macOS: the data-protection keychain (iOS-style; honours kSecAttrAccessible) needs a
	/// signed build with keychain entitlements, so an unsigned dev build or `swift test` process
	/// is probed with a throwaway add and falls back to the legacy file keychain. iOS: always DP.
	private static let usesDataProtection: Bool = {
		#if os(macOS)
			let probe: [String: Any] = [
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: "io.maskin.keychain-probe",
				kSecAttrAccount as String: UUID().uuidString,
				kSecValueData as String: Data([0]),
				kSecUseDataProtectionKeychain as String: true,
			]
			let status = SecItemAdd(probe as CFDictionary, nil)
			if status == errSecSuccess {
				var cleanup = probe
				cleanup[kSecValueData as String] = nil
				SecItemDelete(cleanup as CFDictionary)
			}
			return status == errSecSuccess || status == errSecDuplicateItem
		#else
			return true
		#endif
	}()

	private var query: [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
		#if os(macOS)
			if Self.usesDataProtection { q[kSecUseDataProtectionKeychain as String] = true }
		#endif
		return q
	}

	public func read() throws -> Data? {
		var q = query
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var item: CFTypeRef?
		let status = SecItemCopyMatching(q as CFDictionary, &item)
		if status == errSecItemNotFound { return nil }
		guard status == errSecSuccess else { throw KeychainError(status: status) }
		return item as? Data
	}

	public func write(_ data: Data) throws {
		var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
		if status == errSecItemNotFound {
			var add = query
			add[kSecValueData as String] = data
			// After first unlock, so a push-triggered background fetch can still authenticate;
			// ThisDeviceOnly keeps the key out of backups and device-to-device migration. Revisit
			// only if a shared access group ever needs the session to sync (it does not today).
			add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
			status = SecItemAdd(add as CFDictionary, nil)
		}
		guard status == errSecSuccess else { throw KeychainError(status: status) }
	}

	public func delete() throws {
		let status = SecItemDelete(query as CFDictionary)
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

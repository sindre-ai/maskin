import Foundation
import Security

/// Minimal Keychain wrapper for storing the actor's `ank_...` API key and related
/// session identifiers. There is no server-side expiry/refresh flow (see the plan's
/// Context section) so this key is treated like a stored password — Keychain only,
/// never `UserDefaults`.
enum Keychain {
	private static let service = "io.maskin.app.credentials"

	static func set(_ value: String, forKey key: String) {
		let data = Data(value.utf8)
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: key,
		]
		SecItemDelete(query as CFDictionary)

		var attributes = query
		attributes[kSecValueData as String] = data
		attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
		SecItemAdd(attributes as CFDictionary, nil)
	}

	static func get(_ key: String) -> String? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: key,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var result: AnyObject?
		let status = SecItemCopyMatching(query as CFDictionary, &result)
		guard status == errSecSuccess, let data = result as? Data else { return nil }
		return String(data: data, encoding: .utf8)
	}

	static func remove(_ key: String) {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: key,
		]
		SecItemDelete(query as CFDictionary)
	}

	static func removeAll() {
		remove(KeychainKey.apiKey)
		remove(KeychainKey.actorId)
		remove(KeychainKey.actorName)
		remove(KeychainKey.workspaceId)
	}
}

enum KeychainKey {
	static let apiKey = "apiKey"
	static let actorId = "actorId"
	static let actorName = "actorName"
	static let workspaceId = "workspaceId"
}

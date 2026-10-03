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

/// The four Keychain calls the store makes, so the group/migration logic runs against a fake in
/// tests (the real Keychain's access-group behaviour needs a signed app).
protocol KeychainBackend: Sendable {
	func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: Any?)
	func add(_ attributes: [String: Any]) -> OSStatus
	func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
	func delete(_ query: [String: Any]) -> OSStatus
}

struct SystemKeychain: KeychainBackend {
	func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: Any?) {
		var item: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &item)
		return (status, item)
	}
	func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }
	func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
		SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
	}
	func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }

	/// Which keychain this process uses, decided ONCE so read/write/delete never straddle two
	/// stores. macOS: the data-protection keychain (iOS-style; honours kSecAttrAccessible) needs a
	/// signed build with keychain entitlements, so an unsigned dev build or `swift test` process
	/// is probed with a throwaway add and falls back to the legacy file keychain. iOS: always DP.
	static let usesDataProtection: Bool = {
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

	/// The access group this process's items land in when no group is named: the FIRST entry of
	/// its `keychain-access-groups` entitlement (`<TeamID>.io.maskin.app`, shared with the share
	/// extension). Read back from a throwaway item rather than assembled from a team prefix we
	/// would have to plumb through Info.plist. `nil` when it can't be determined (an unsigned
	/// build, or the macOS file keychain, which has no groups) and the store then behaves as a
	/// single, ungrouped item.
	static let defaultAccessGroup: String? = {
		#if os(macOS)
			guard usesDataProtection else { return nil }
		#endif
		var probe: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: "io.maskin.keychain-probe",
			kSecAttrAccount as String: "group-" + UUID().uuidString,
			kSecValueData as String: Data([0]),
			kSecReturnAttributes as String: true,
		]
		#if os(macOS)
			probe[kSecUseDataProtectionKeychain as String] = true
		#endif
		var item: CFTypeRef?
		let status = SecItemAdd(probe as CFDictionary, &item)
		guard status == errSecSuccess else { return nil }
		var cleanup = probe
		cleanup[kSecValueData as String] = nil
		cleanup[kSecReturnAttributes as String] = nil
		SecItemDelete(cleanup as CFDictionary)
		return (item as? [String: Any])?[kSecAttrAccessGroup as String] as? String
	}()
}

/// One generic-password item, kept in the SHARED keychain access group so the app and its share
/// extension (separate processes) read the same session.
///
/// Older builds wrote the item without naming a group. Reads therefore fall back to that old
/// location, copy what they find into the shared group and then remove ONLY the old copy, so an
/// existing install is never signed out by the move. If the shared group is unusable (missing
/// entitlement, keychain error) the store degrades to the old behaviour instead of failing: signing
/// in must keep working even when sharing doesn't.
public struct KeychainSecretStore: SecretStore {
	public let service: String
	public let account: String
	/// The group the item lives in. `nil` only when no group can be determined at all.
	public let accessGroup: String?

	private let backend: any KeychainBackend
	private let dataProtection: Bool

	/// - Parameter accessGroup: leave `nil` to use this process's shared group (resolved at runtime).
	public init(
		service: String = "io.maskin.app", account: String = "session", accessGroup: String? = nil
	) {
		self.init(
			service: service, account: account,
			accessGroup: accessGroup ?? SystemKeychain.defaultAccessGroup,
			backend: SystemKeychain(), dataProtection: SystemKeychain.usesDataProtection)
	}

	init(
		service: String, account: String, accessGroup: String?, backend: any KeychainBackend,
		dataProtection: Bool = true
	) {
		self.service = service
		self.account = account
		self.accessGroup = accessGroup
		self.backend = backend
		self.dataProtection = dataProtection
	}

	/// `group == nil` matches the item in EVERY group this process can reach (the pre-migration
	/// behaviour, and what sign-out must wipe); a name matches that group only.
	private func query(group: String?) -> [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		if let group { q[kSecAttrAccessGroup as String] = group }
		#if os(macOS)
			if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
		#endif
		return q
	}

	private enum Lookup {
		case found(Data, group: String?)
		case missing
		case failed(OSStatus)
	}

	private func lookup(group: String?) -> Lookup {
		var q = query(group: group)
		q[kSecReturnData as String] = true
		q[kSecReturnAttributes as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		let (status, result) = backend.copyMatching(q)
		if status == errSecItemNotFound { return .missing }
		guard status == errSecSuccess else { return .failed(status) }
		guard let row = result as? [String: Any], let data = row[kSecValueData as String] as? Data
		else { return .missing }
		return .found(data, group: row[kSecAttrAccessGroup as String] as? String)
	}

	public func read() throws -> Data? {
		guard let shared = accessGroup else {
			switch lookup(group: nil) {
			case .found(let data, _): return data
			case .missing: return nil
			case .failed(let status): throw KeychainError(status: status)
			}
		}
		var sharedFailure: OSStatus?
		switch lookup(group: shared) {
		case .found(let data, _): return data
		case .missing: break
		case .failed(let status): sharedFailure = status
		}
		// Not in the shared group: look where older builds put it.
		switch lookup(group: nil) {
		case .found(let data, let oldGroup):
			if sharedFailure == nil, let oldGroup, oldGroup != shared {
				migrate(data, from: oldGroup, to: shared)
			}
			return data
		case .missing:
			if let sharedFailure { throw KeychainError(status: sharedFailure) }
			return nil
		case .failed(let status):
			throw KeychainError(status: sharedFailure ?? status)
		}
	}

	/// Copy first, delete second, and delete only the group the data was found in: an ungrouped
	/// delete would also remove the copy just written. Every failure leaves the old item in
	/// place for the next read to try again.
	private func migrate(_ data: Data, from oldGroup: String, to shared: String) {
		guard (try? store(data, in: shared)) != nil else { return }
		_ = backend.delete(query(group: oldGroup))
	}

	public func write(_ data: Data) throws {
		guard let shared = accessGroup else {
			try store(data, in: nil)
			return
		}
		do {
			try store(data, in: shared)
		} catch {
			// The shared group is unusable here: keep the session working in the old place.
			try store(data, in: nil)
			return
		}
		removeCopies(outside: shared)
	}

	private func store(_ data: Data, in group: String?) throws {
		var status = backend.update(query(group: group), [kSecValueData as String: data])
		if status == errSecItemNotFound {
			var add = query(group: group)
			add[kSecValueData as String] = data
			// After first unlock, so a push-triggered background fetch can still authenticate;
			// ThisDeviceOnly keeps the key out of backups and device-to-device migration (a shared
			// access group does not change that: it shares between apps, not between devices).
			add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
			status = backend.add(add)
		}
		guard status == errSecSuccess else { throw KeychainError(status: status) }
	}

	/// A stale copy in an old group must not outlive the fresh write (it would hold a dead key).
	private func removeCopies(outside shared: String) {
		var q = query(group: nil)
		q[kSecReturnAttributes as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitAll
		let (status, result) = backend.copyMatching(q)
		guard status == errSecSuccess, let rows = result as? [[String: Any]] else { return }
		for group in Set(rows.compactMap { $0[kSecAttrAccessGroup as String] as? String })
		where group != shared {
			_ = backend.delete(query(group: group))
		}
	}

	/// Sign-out: removes the item from every group this process can reach, old and shared.
	public func delete() throws {
		let status = backend.delete(query(group: nil))
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

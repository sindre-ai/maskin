import Foundation
import Security
import Testing

@testable import MaskinCore

/// An in-memory stand-in for the Keychain that models the parts the store depends on: items live
/// in an access group, a query naming a group sees only that group, a query naming none sees every
/// group the process can reach, and a new item without a group lands in the default group.
private final class FakeKeychain: KeychainBackend, @unchecked Sendable {
	struct Item: Equatable {
		var service: String
		var account: String
		var group: String
		var data: Data
		var accessible: String?
	}

	enum Op: Equatable { case copy, add, update, delete }

	private let lock = NSLock()
	private var items: [Item] = []
	let defaultGroup: String
	let reachable: Set<String>
	/// Return a status instead of performing the call.
	var failing: @Sendable (Op, [String: Any]) -> OSStatus? = { _, _ in nil }
	private(set) var calls: [Op] = []

	init(defaultGroup: String = "TEAM.io.maskin.app", reachable: Set<String>? = nil) {
		self.defaultGroup = defaultGroup
		self.reachable = reachable ?? [defaultGroup, "TEAM.io.maskin.app"]
	}

	func seed(group: String, data: Data, service: String = "io.maskin.app", account: String = "session") {
		lock.withLock {
			items.append(Item(service: service, account: account, group: group, data: data, accessible: nil))
		}
	}

	var snapshot: [Item] { lock.withLock { items } }

	private func matches(_ q: [String: Any]) -> [Int] {
		let group = q[kSecAttrAccessGroup as String] as? String
		return items.indices.filter {
			let item = items[$0]
			return item.service == q[kSecAttrService as String] as? String
				&& item.account == q[kSecAttrAccount as String] as? String
				&& reachable.contains(item.group) && (group == nil || item.group == group)
		}
	}

	private func denied(_ q: [String: Any]) -> Bool {
		if let group = q[kSecAttrAccessGroup as String] as? String { return !reachable.contains(group) }
		return false
	}

	func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: Any?) {
		lock.withLock {
			calls.append(.copy)
			if let s = failing(.copy, query) { return (s, nil) }
			if denied(query) { return (errSecMissingEntitlement, nil) }
			let hits = matches(query)
			guard !hits.isEmpty else { return (errSecItemNotFound, nil) }
			func row(_ i: Int) -> [String: Any] {
				var r: [String: Any] = [:]
				if query[kSecReturnAttributes as String] as? Bool == true {
					r[kSecAttrAccessGroup as String] = items[i].group
				}
				if query[kSecReturnData as String] as? Bool == true { r[kSecValueData as String] = items[i].data }
				return r
			}
			if query[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String {
				return (errSecSuccess, hits.map(row))
			}
			// Like the real thing, a bare data request returns the Data itself.
			if query[kSecReturnAttributes as String] as? Bool != true {
				return (errSecSuccess, items[hits[0]].data)
			}
			return (errSecSuccess, row(hits[0]))
		}
	}

	func add(_ attributes: [String: Any]) -> OSStatus {
		lock.withLock {
			calls.append(.add)
			if let s = failing(.add, attributes) { return s }
			if denied(attributes) { return errSecMissingEntitlement }
			let group = attributes[kSecAttrAccessGroup as String] as? String ?? defaultGroup
			var probe = attributes
			probe[kSecAttrAccessGroup as String] = group
			if !matches(probe).isEmpty { return errSecDuplicateItem }
			items.append(
				Item(
					service: attributes[kSecAttrService as String] as! String,
					account: attributes[kSecAttrAccount as String] as! String, group: group,
					data: attributes[kSecValueData as String] as! Data,
					accessible: attributes[kSecAttrAccessible as String] as? String))
			return errSecSuccess
		}
	}

	func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
		lock.withLock {
			calls.append(.update)
			if let s = failing(.update, query) { return s }
			if denied(query) { return errSecMissingEntitlement }
			let hits = matches(query)
			guard !hits.isEmpty else { return errSecItemNotFound }
			for i in hits { items[i].data = attributes[kSecValueData as String] as! Data }
			return errSecSuccess
		}
	}

	func delete(_ query: [String: Any]) -> OSStatus {
		lock.withLock {
			calls.append(.delete)
			if let s = failing(.delete, query) { return s }
			if denied(query) { return errSecMissingEntitlement }
			let hits = Set(matches(query))
			guard !hits.isEmpty else { return errSecItemNotFound }
			items = items.enumerated().filter { !hits.contains($0.offset) }.map(\.element)
			return errSecSuccess
		}
	}
}

private let shared = "TEAM.io.maskin.app"
private let oldGroup = "TEAM.old"
private let blob = Data("session-v1".utf8)

private func makeStore(_ keychain: FakeKeychain, group: String? = shared) -> KeychainSecretStore {
	KeychainSecretStore(
		service: "io.maskin.app", account: "session", accessGroup: group, backend: keychain)
}

@Suite("KeychainSecretStore access-group migration")
struct SecretStoreMigrationTests {
	@Test("fresh install: nothing stored reads as nil and a write lands in the shared group")
	func freshInstall() throws {
		let kc = FakeKeychain()
		let store = makeStore(kc)
		#expect(try store.read() == nil)
		try store.write(blob)
		#expect(kc.snapshot.map(\.group) == [shared])
		#expect(kc.snapshot.first?.accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
		#expect(try store.read() == blob)
	}

	@Test("an item in the old group is copied to the shared group and the old copy removed")
	func migratesOldToNew() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		let store = makeStore(kc)
		#expect(try store.read() == blob)
		let items = kc.snapshot
		#expect(items.map(\.group) == [shared])
		#expect(items.first?.data == blob)
		#expect(items.first?.accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
		// A second read is served from the shared group alone.
		#expect(try store.read() == blob)
	}

	@Test("the old item is deleted by its own group so the fresh copy survives")
	func deletesOnlyTheOldCopy() throws {
		// An ungrouped delete would match both groups: the migration must name the old one.
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		_ = try makeStore(kc).read()
		#expect(kc.snapshot.contains { $0.group == shared && $0.data == blob })
	}

	@Test("both present: the shared copy wins and nothing is signed out")
	func bothPresentSharedWins() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		let newer = Data("session-v2".utf8)
		kc.seed(group: oldGroup, data: blob)
		kc.seed(group: shared, data: newer)
		let store = makeStore(kc)
		#expect(try store.read() == newer)
		// The stale copy is cleaned on the next write, never promoted over the shared one.
		try store.write(newer)
		#expect(kc.snapshot.map(\.group) == [shared])
	}

	@Test("a failed copy keeps the session readable and leaves the old item for next time")
	func migrationCopyFails() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		kc.failing = { op, q in
			op == .add && q[kSecAttrAccessGroup as String] as? String == shared ? errSecInteractionNotAllowed : nil
		}
		let store = makeStore(kc)
		#expect(try store.read() == blob)
		#expect(kc.snapshot.map(\.group) == [oldGroup])
		// Once the keychain recovers, the next read completes the move.
		kc.failing = { _, _ in nil }
		#expect(try store.read() == blob)
		#expect(kc.snapshot.map(\.group) == [shared])
	}

	@Test("a failed delete of the old copy still returns the session; the shared copy wins afterwards")
	func migrationDeleteFails() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		kc.failing = { op, _ in op == .delete ? errSecInteractionNotAllowed : nil }
		let store = makeStore(kc)
		#expect(try store.read() == blob)
		#expect(Set(kc.snapshot.map(\.group)) == [shared, oldGroup])
		#expect(try store.read() == blob)
	}

	@Test("shared group unreachable: reads fall back to the old location without migrating")
	func sharedGroupUnreachable() throws {
		let kc = FakeKeychain(defaultGroup: oldGroup, reachable: [oldGroup])
		kc.seed(group: oldGroup, data: blob)
		let store = makeStore(kc)
		#expect(try store.read() == blob)
		#expect(kc.snapshot.map(\.group) == [oldGroup])
	}

	@Test("shared group unreachable: a write still signs in, in the old location")
	func writeFallsBack() throws {
		let kc = FakeKeychain(defaultGroup: oldGroup, reachable: [oldGroup])
		let store = makeStore(kc)
		try store.write(blob)
		#expect(kc.snapshot.map(\.group) == [oldGroup])
		#expect(try store.read() == blob)
	}

	@Test("a Keychain error with nothing stored anywhere is thrown, not read as signed out")
	func errorIsNotSignedOut() {
		let kc = FakeKeychain()
		kc.failing = { _, _ in errSecInteractionNotAllowed }
		#expect(throws: KeychainError(status: errSecInteractionNotAllowed)) {
			_ = try makeStore(kc).read()
		}
	}

	@Test("a write replaces the shared copy and sweeps a stale old-group copy")
	func writeSweepsStale() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		let store = makeStore(kc)
		let fresh = Data("fresh".utf8)
		try store.write(fresh)
		#expect(kc.snapshot.map(\.group) == [shared])
		#expect(try store.read() == fresh)
	}

	@Test("rewriting an existing shared item updates it in place")
	func updatesInPlace() throws {
		let kc = FakeKeychain()
		let store = makeStore(kc)
		try store.write(blob)
		try store.write(Data("v2".utf8))
		#expect(kc.snapshot.count == 1)
		#expect(try store.read() == Data("v2".utf8))
	}

	@Test("sign-out removes the item from every group")
	func deleteRemovesAll() throws {
		let kc = FakeKeychain(reachable: [shared, oldGroup])
		kc.seed(group: oldGroup, data: blob)
		kc.seed(group: shared, data: blob)
		try makeStore(kc).delete()
		#expect(kc.snapshot.isEmpty)
		#expect(try makeStore(kc).read() == nil)
	}

	@Test("deleting nothing is not an error; a real failure is")
	func deleteErrors() {
		let kc = FakeKeychain()
		#expect(throws: Never.self) { try makeStore(kc).delete() }
		kc.failing = { _, _ in errSecInteractionNotAllowed }
		#expect(throws: KeychainError(status: errSecInteractionNotAllowed)) { try makeStore(kc).delete() }
	}

	@Test("no group determinable: a single ungrouped item, as before")
	func noGroup() throws {
		let kc = FakeKeychain()
		let store = makeStore(kc, group: nil)
		try store.write(blob)
		#expect(kc.snapshot.map(\.group) == [kc.defaultGroup])
		#expect(try store.read() == blob)
		try store.delete()
		#expect(try store.read() == nil)
	}

	@Test("the session blob never leaves the device or becomes readable before first unlock")
	func accessibility() throws {
		let kc = FakeKeychain()
		try makeStore(kc).write(blob)
		#expect(kc.snapshot.first?.accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
	}

	@Test("app and extension, two stores on the same group, see one session")
	func appAndExtensionShare() throws {
		let kc = FakeKeychain()
		try makeStore(kc).write(blob)
		let extensionStore = makeStore(kc)
		#expect(try extensionStore.read() == blob)
		try extensionStore.delete()
		#expect(try makeStore(kc).read() == nil)
	}
}

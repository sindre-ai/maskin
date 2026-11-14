import Foundation
import Testing

@testable import MaskinCore

private final class FakeGeneral: GeneralSettingsAPI, @unchecked Sendable {
	private let lock = NSLock()
	private var _calls: [String] = []
	var calls: [String] { lock.withLock { _calls } }
	var failing = false

	private func record(_ call: String) throws {
		try lock.withLock {
			_calls.append(call)
			if failing { throw SettingsError("nope") }
		}
	}

	func setDefaultWorkspace(actorId: String, workspaceId: String?, idempotencyKey: String) async throws {
		try record("default:\(actorId):\(workspaceId ?? "nil")")
	}

	func setPrivacy(workspaceId: String, shareUsage: Bool, anonymize: Bool, idempotencyKey: String)
		async throws
	{
		try record("privacy:\(workspaceId):\(shareUsage):\(anonymize)")
	}
}

@MainActor
private final class Counter { var count = 0 }

@MainActor
@Suite("GeneralSettingsStore")
struct GeneralSettingsStoreTests {
	private func make(
		_ api: FakeGeneral, isDefault: Bool = false, canWritePrivacy: Bool = true,
		refreshed: @escaping @MainActor () -> Void = {}
	) -> GeneralSettingsStore {
		GeneralSettingsStore(
			api: api, actorId: "me",
			workspace: WorkspaceSummary(id: "ws", name: "Acme", role: "owner", memberCount: 1, isDefault: isDefault),
			canWritePrivacy: canWritePrivacy, refreshWorkspaces: { refreshed() })
	}

	@Test("starts from the workspace row: usage shared, not anonymous, as the server defaults")
	func initialValues() {
		let store = make(FakeGeneral())
		#expect(!store.isDefault)
		#expect(store.shareUsage)
		#expect(!store.anonymize)
	}

	@Test("making it the default sends this workspace; switching off clears it with nil")
	func defaultWorkspace() async {
		let api = FakeGeneral()
		let refreshes = Counter()
		let store = make(api, refreshed: { refreshes.count += 1 })
		await store.setDefault(true)
		#expect(store.isDefault)
		await store.setDefault(false)
		#expect(!store.isDefault)
		#expect(api.calls == ["default:me:ws", "default:me:nil"])
		#expect(refreshes.count == 2)
	}

	@Test("each privacy switch sends both values, keeping the other as it was")
	func privacy() async {
		let api = FakeGeneral()
		let store = make(api)
		await store.setShareUsage(false)
		await store.setAnonymize(true)
		#expect(api.calls == ["privacy:ws:false:false", "privacy:ws:false:true"])
		#expect(!store.shareUsage)
		#expect(store.anonymize)
	}

	@Test("a refused change goes back and says so, in the web's words")
	func rollback() async {
		let api = FakeGeneral()
		api.failing = true
		let store = make(api)
		await store.setDefault(true)
		#expect(!store.isDefault)
		#expect(store.error == "Failed to update your default workspace")
		await store.setShareUsage(false)
		#expect(store.shareUsage)
		#expect(store.error == "Failed to update privacy settings")
		store.dismissError()
		#expect(store.error == nil)
	}

	@Test("a viewer can't change privacy but can still pick their default")
	func viewer() async {
		let api = FakeGeneral()
		let store = make(api, canWritePrivacy: false)
		await store.setAnonymize(true)
		#expect(!store.anonymize)
		#expect(api.calls.isEmpty)
		await store.setDefault(true)
		#expect(store.isDefault)
	}

	@Test("an old cached workspace list without the new fields still decodes")
	func oldCache() throws {
		let json = Data(#"[{"id":"w","name":"A","role":"owner","memberCount":2}]"#.utf8)
		let row = try JSONDecoder().decode([WorkspaceSummary].self, from: json)[0]
		#expect(!row.isDefault)
		#expect(row.shareUsage)
		#expect(!row.anonymize)
	}
}

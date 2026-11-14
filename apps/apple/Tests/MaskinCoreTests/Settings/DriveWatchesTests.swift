import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("DriveWatchesStore")
struct DriveWatchesStoreTests {
	final class FakeAPI: DriveWatchesAPI, @unchecked Sendable {
		var watches: [DriveWatch]
		var listFailure: SettingsError?
		var stopFailure: SettingsError?
		private(set) var stopped: [String] = []
		init(_ watches: [DriveWatch]) { self.watches = watches }
		func list() async throws -> [DriveWatch] {
			if let listFailure { throw listFailure }
			return watches
		}
		func stop(folderId: String, idempotencyKey: String) async throws {
			if let stopFailure { throw stopFailure }
			stopped.append(folderId)
		}
	}

	private func watch(_ folder: String, name: String = "Briefs", path: String? = nil) -> DriveWatch {
		DriveWatch(folderId: folder, name: name, path: path, integrationId: "i1", account: "a@b.co")
	}

	@Test("loads the watched folders")
	func loads() async {
		let store = DriveWatchesStore(api: FakeAPI([watch("f1"), watch("f2")]), canManage: true)
		await store.load()
		#expect(store.watches.map(\.folderId) == ["f1", "f2"])
	}

	@Test("a failed first load says so, and a later failure keeps the list")
	func loadFailure() async {
		let api = FakeAPI([watch("f1")])
		api.listFailure = SettingsError("Nope.")
		let store = DriveWatchesStore(api: api, canManage: true)
		await store.load()
		#expect(store.phase == .failed("Nope."))
		api.listFailure = nil
		await store.load()
		api.listFailure = SettingsError("Later.")
		await store.load()
		#expect(store.watches.map(\.folderId) == ["f1"])
	}

	@Test("stopping calls the server, then drops the row")
	func stops() async {
		let api = FakeAPI([watch("f1"), watch("f2")])
		let store = DriveWatchesStore(api: api, canManage: true)
		await store.load()
		await store.stop(store.watches[0])
		#expect(api.stopped == ["f1"])
		#expect(store.watches.map(\.folderId) == ["f2"])
		#expect(store.stoppingIDs.isEmpty && store.actionError == nil)
	}

	@Test("a refused stop keeps the row and shows the server's sentence")
	func stopRefused() async {
		let api = FakeAPI([watch("f1")])
		api.stopFailure = SettingsError("Folder watch not found")
		let store = DriveWatchesStore(api: api, canManage: true)
		await store.load()
		await store.stop(store.watches[0])
		#expect(store.watches.count == 1)
		#expect(store.actionError == "Folder watch not found")
	}

	@Test("people who can't manage cannot stop a watch")
	func readOnly() async {
		let api = FakeAPI([watch("f1")])
		let store = DriveWatchesStore(api: api, canManage: false)
		await store.load()
		await store.stop(store.watches[0])
		#expect(api.stopped.isEmpty && store.watches.count == 1)
	}
}

@Suite("DriveWatch.displayPath")
struct DriveWatchPathTests {
	private func path(_ name: String, _ path: String?) -> String {
		DriveWatch(folderId: "f", name: name, path: path, integrationId: "i").displayPath
	}

	@Test("the folder's own name closes the stored ancestors")
	func closes() {
		#expect(path("Briefs", nil) == "Briefs")
		#expect(path("Briefs", "") == "Briefs")
		#expect(path("Briefs", "My Drive/Clients") == "My Drive/Clients/Briefs")
		#expect(path("Briefs", "My Drive/Clients/") == "My Drive/Clients/Briefs")
	}

	@Test("a path that already ends in the name is not doubled")
	func notDoubled() {
		#expect(path("Briefs", "My Drive/Briefs") == "My Drive/Briefs")
	}
}

import Foundation
import Testing

@testable import MaskinCore

actor FakeMarketplaceAPI: MarketplaceAPI {
	var loops: [MarketplaceLoop]
	var installed: [InstalledLoop]
	var fail = false
	private(set) var installKeys: [String] = []
	private(set) var forked: [String] = []
	private(set) var uninstalled: [(String, Bool)] = []

	init(loops: [MarketplaceLoop], installed: [InstalledLoop] = []) {
		self.loops = loops
		self.installed = installed
	}

	func setFail(_ value: Bool) { fail = value }

	func catalog() async throws -> [MarketplaceLoop] {
		if fail { throw AutomationError("offline") }
		return loops
	}
	func detail(loopID: String) async throws -> MarketplaceLoopDetail {
		guard let loop = loops.first(where: { $0.id == loopID }) else { throw AutomationError("gone") }
		return MarketplaceLoopDetail(loop: loop, items: [])
	}
	func installs() async throws -> [InstalledLoop] { installed }

	func install(loopID: String, idempotencyKey: String) async throws -> InstalledLoop {
		installKeys.append(idempotencyKey)
		if fail { throw AutomationError("server said no") }
		let row = InstalledLoop(id: "i-\(loopID)", sourceLoopID: loopID, objectID: "obj-\(loopID)")
		installed.append(row)
		return row
	}
	func fork(installID: String, idempotencyKey: String) async throws {
		if fail { throw AutomationError("nope") }
		forked.append(installID)
		if let i = installed.firstIndex(where: { $0.id == installID }) { installed[i].isForked = true }
	}
	func uninstall(installID: String, keepProvisionedItems: Bool, idempotencyKey: String) async throws {
		if fail { throw AutomationError("nope") }
		uninstalled.append((installID, keepProvisionedItems))
		installed.removeAll { $0.id == installID }
	}
}

private let catalogRows = [
	MarketplaceLoop(
		id: "l1", name: "Sales rep", summary: "Follows up leads", version: "2.0.0", useCase: "Sales",
		itemKinds: [.actor, .actor, .trigger]),
	MarketplaceLoop(id: "l2", name: "Inbox triage", summary: "Sorts mail", useCase: "Support"),
]

@MainActor
@Suite("MarketplaceStore")
struct MarketplaceStoreTests {
	@Test("loads the catalog and the installs")
	func load() async {
		let store = MarketplaceStore(
			api: FakeMarketplaceAPI(
				loops: catalogRows, installed: [InstalledLoop(id: "i1", sourceLoopID: "l1")]))
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.catalog.count == 2)
		#expect(store.useCases == ["Sales", "Support"])
		if case .installed = store.state(of: "l1") {} else { Issue.record("expected installed") }
		#expect(store.state(of: "l2") == .notInstalled)
	}

	@Test("filters by use case and search text")
	func filter() async {
		let store = MarketplaceStore(api: FakeMarketplaceAPI(loops: catalogRows))
		await store.load()
		#expect(store.loops(useCase: "Sales", query: "").map(\.id) == ["l1"])
		#expect(store.loops(useCase: nil, query: "mail").map(\.id) == ["l2"])
		#expect(store.loops(useCase: "Sales", query: "mail").isEmpty)
	}

	@Test("a failed first load reports the error")
	func failure() async {
		let api = FakeMarketplaceAPI(loops: [])
		await api.setFail(true)
		let store = MarketplaceStore(api: api)
		await store.load()
		#expect(store.phase == .failed("offline"))
	}

	@Test("installing returns the new loop's object id and notifies the list")
	func install() async {
		let store = MarketplaceStore(api: FakeMarketplaceAPI(loops: catalogRows))
		await store.load()
		var changed = 0
		store.onLoopsChanged = { changed += 1 }
		let object = await store.installLoop("l2")
		#expect(object == "obj-l2")
		#expect(changed == 1)
		if case .installed(let row) = store.state(of: "l2") {
			#expect(row.id == "i-l2")
		} else {
			Issue.record("expected installed")
		}
		// A second tap on an installed loop does nothing.
		#expect(await store.installLoop("l2") == nil)
	}

	@Test("a failed install explains and a retry reuses the idempotency key")
	func installRetry() async {
		let api = FakeMarketplaceAPI(loops: catalogRows)
		await api.setFail(true)
		let store = MarketplaceStore(api: api)
		#expect(await store.installLoop("l1") == nil)
		#expect(store.notice?.contains("Couldn't install") == true)
		#expect(store.state(of: "l1") == .notInstalled)
		_ = await store.installLoop("l1")
		let keys = await api.installKeys
		#expect(keys.count == 2)
		#expect(keys[0] == keys[1])
	}

	@Test("update note differs for a followed install and a fork")
	func updateNote() {
		let followed = InstalledLoop(
			id: "i", sourceLoopID: "l", installedVersion: "1.0.0", availableVersion: "2.0.0",
			hasUpdate: true)
		#expect(followed.updateNote == "Update to v2.0.0 available.")
		var fork = followed
		fork.isForked = true
		#expect(fork.updateNote?.contains("Your fork stays at v1.0.0") == true)
		#expect(InstalledLoop(id: "i", sourceLoopID: "l").updateNote == nil)
	}

	@Test("forking marks the install as a fork")
	func fork() async {
		let store = MarketplaceStore(
			api: FakeMarketplaceAPI(
				loops: catalogRows, installed: [InstalledLoop(id: "i1", sourceLoopID: "l1")]))
		await store.load()
		await store.fork("i1")
		#expect(store.install(for: "l1")?.isForked == true)
	}

	@Test("removing is optimistic and rolls back when refused")
	func uninstall() async {
		let api = FakeMarketplaceAPI(
			loops: catalogRows, installed: [InstalledLoop(id: "i1", sourceLoopID: "l1")])
		let store = MarketplaceStore(api: api)
		await store.load()
		await store.uninstall("i1", keepProvisionedItems: true)
		#expect(store.install(for: "l1") == nil)
		#expect(await api.uninstalled.first?.1 == true)

		let failing = FakeMarketplaceAPI(
			loops: catalogRows, installed: [InstalledLoop(id: "i1", sourceLoopID: "l1")])
		await failing.setFail(false)
		let other = MarketplaceStore(api: failing)
		await other.load()
		await failing.setFail(true)
		await other.uninstall("i1", keepProvisionedItems: false)
		#expect(other.install(for: "l1") != nil)
		#expect(other.notice?.contains("Couldn't remove") == true)
	}

	@Test("contents line counts parts")
	func contents() {
		#expect(catalogRows[0].contentsLine == "2 agents · 1 trigger")
		#expect(catalogRows[1].contentsLine == "")
	}
}

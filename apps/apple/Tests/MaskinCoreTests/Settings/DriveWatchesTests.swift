import Foundation
import Testing

@testable import MaskinCore

private final class FakeDriveWatches: DriveWatchesAPI, @unchecked Sendable {
	private let lock = NSLock()
	private var _stopped: [String] = []
	private var _keys: [String] = []
	var list: [DriveWatch] = []
	var failure: SettingsError?
	var stopped: [String] { lock.withLock { _stopped } }
	var keys: [String] { lock.withLock { _keys } }

	func watches() async throws -> [DriveWatch] {
		if let failure { throw failure }
		return list
	}

	func stop(folderId: String, idempotencyKey: String) async throws {
		lock.withLock {
			_stopped.append(folderId)
			_keys.append(idempotencyKey)
		}
		if let failure { throw failure }
	}
}

private let briefs = DriveWatch(
	folderId: "f1", name: "Briefs", path: "/Clients/Acme", integrationId: "i1", account: "sebastian@example.com",
	triggerNames: ["New brief"])
private let invoices = DriveWatch(folderId: "f2", name: "Invoices", integrationId: "i1")

@Suite("Drive folder watches")
struct DriveWatchesTests {
	@Test func displayPathEndsWithTheFolderNameOnce() {
		#expect(briefs.displayPath == "/Clients/Acme/Briefs")
		#expect(DriveWatch(folderId: "f", name: "Briefs", path: "/Clients/Briefs/", integrationId: "i").displayPath == "/Clients/Briefs")
		#expect(invoices.displayPath == "Invoices")
	}

	@Test func longPathsDropLeadingFoldersNeverCutAName() {
		let path = "/My Drive/Clients/Acme Corporation/Quarterly Reports/2026/Briefs"
		#expect(DriveWatch.truncatePath(path) == "…/Clients/Acme Corporation/Quarterly Reports/2026/Briefs")
		#expect(DriveWatch.truncatePath("/Clients/Acme/Briefs") == "/Clients/Acme/Briefs")
		let longName = String(repeating: "a", count: 80)
		#expect(DriveWatch.truncatePath("/Clients/\(longName)") == "…/\(longName)")
	}

	@Test func theHumanIsTheAccountNameWithoutTheDomain() {
		#expect(briefs.humanName == "sebastian")
		#expect(invoices.humanName == nil)
	}

	@MainActor @Test func loadListsTheWatches() async {
		let api = FakeDriveWatches()
		api.list = [briefs, invoices]
		let store = DriveWatchesStore(api: api, canWrite: true)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.watches == [briefs, invoices])
	}

	@MainActor @Test func aFailedLoadShowsTheWebsSentence() async {
		let api = FakeDriveWatches()
		api.failure = SettingsError(DriveWatchesCopy.loadError)
		let store = DriveWatchesStore(api: api, canWrite: true)
		await store.load()
		#expect(store.phase == .failed("Could not load folder watches"))
	}

	@MainActor @Test func stopRemovesTheRowAndCallsTheServerOnce() async {
		let api = FakeDriveWatches()
		api.list = [briefs, invoices]
		let store = DriveWatchesStore(api: api, canWrite: true)
		await store.load()
		await store.stop(briefs)
		#expect(store.watches == [invoices])
		#expect(api.stopped == ["f1"])
		#expect(api.keys.count == 1)
		#expect(store.actionError == nil)
	}

	@MainActor @Test func aRefusedStopPutsTheRowBackInPlace() async {
		let api = FakeDriveWatches()
		api.list = [briefs, invoices]
		let store = DriveWatchesStore(api: api, canWrite: true)
		await store.load()
		api.failure = SettingsError("You can't do that here.")
		await store.stop(briefs)
		#expect(store.watches == [briefs, invoices])
		#expect(store.actionError == "You can't do that here.")
		#expect(store.stopping.isEmpty)
	}

	@MainActor @Test func aViewerCannotStopAWatch() async {
		let api = FakeDriveWatches()
		api.list = [briefs]
		let store = DriveWatchesStore(api: api, canWrite: false)
		await store.load()
		await store.stop(briefs)
		#expect(store.watches == [briefs])
		#expect(api.stopped.isEmpty)
	}

	@MainActor @Test func theIntegrationsListKnowsWhenDriveIsConnected() async {
		let fake = FakeSettings()
		fake.connectedList = [ConnectedIntegration(id: "d", provider: "google-drive", state: .needsReconnect(missingScopes: 0))]
		let store = IntegrationsStore(api: fake, currentRole: .member)
		await store.load()
		#expect(!store.hasConnectedDrive)
		fake.connectedList = [ConnectedIntegration(id: "d", provider: "google-drive", state: .connected)]
		await store.load()
		#expect(store.hasConnectedDrive)
	}
}

import Foundation
import Testing

@testable import MaskinCore

private final class FakeDirectory: CallDirectoryControlling, @unchecked Sendable {
	struct Failure: Error {}
	private let lock = NSLock()
	private var _status: CallerIDStatus
	private var _reloads = 0
	var failReload = false

	init(status: CallerIDStatus) { _status = status }

	var reloads: Int { lock.withLock { _reloads } }
	func set(_ status: CallerIDStatus) { lock.withLock { _status = status } }
	func status() async -> CallerIDStatus { lock.withLock { _status } }
	func reload() async throws {
		lock.withLock { _reloads += 1 }
		if failReload { throw Failure() }
	}
}

@MainActor
private final class RecordingSink: AnalyticsSink {
	var events: [(name: String, properties: AnalyticsProperties)] = []
	func start() {}
	func identify(_ distinctId: String) {}
	func group(type: String, key: String) {}
	func capture(_ event: String, properties: AnalyticsProperties) { events.append((event, properties)) }
	func reset() {}
	func stop() {}
}

@MainActor
@Suite("CallerIDStatusStore")
struct CallerIDStoreTests {
	@Test("counts fall into buckets at their edges, and 1,000 numbers reads as 1000_plus")
	func buckets() {
		#expect([-1, 0, 1, 100, 101, 500, 501, 999, 1000, 1065, 5000].map(CallerIDTracking.numbersBucket) == [
			"0", "0", "1_100", "1_100", "101_500", "101_500", "501_1000", "501_1000", "1000_plus", "1000_plus",
			"1000_plus",
		])
	}

	@Test("the row shows the phone's own answer and the file's count")
	func status() async {
		let directory = FakeDirectory(status: .disabled)
		let store = CallerIDStatusStore(directory: directory, countLoaded: { 1065 })
		#expect(store.status == .unknown)
		await store.refreshStatus()
		#expect(store.status == .disabled)
		#expect(store.loadedCount == 1065)

		directory.set(.enabled)
		await store.refreshStatus()
		#expect(store.status == .enabled)
	}

	@Test("a reload asks the phone once and re-reads the status; a failed reload is not an error")
	func reload() async {
		let directory = FakeDirectory(status: .enabled)
		directory.failReload = true
		let store = CallerIDStatusStore(directory: directory, countLoaded: { 0 })
		await store.reloadPhone()
		#expect(directory.reloads == 1)
		#expect(store.status == .enabled)
		#expect(store.loadedCount == 0)
	}

	@Test("the event carries a status and a bucket, never a number or a name, and nothing without consent")
	func event() async {
		let sink = RecordingSink()
		let analytics = Analytics()
		analytics.configure(sink: sink, storage: InMemoryAnalyticsStorage())
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		let store = CallerIDStatusStore(directory: FakeDirectory(status: .enabled), countLoaded: { 1065 })

		await store.reportStatus(to: analytics)
		#expect(sink.events.isEmpty, "no consent yet")

		analytics.setConsent(true)
		sink.events.removeAll()
		await store.reportStatus(to: analytics)

		#expect(sink.events.map(\.name) == ["caller_id_status"])
		let properties = sink.events[0].properties
		#expect(properties["status"] == "enabled")
		#expect(properties["numbers_bucket"] == "1000_plus")
		#expect(properties["surface"] == "iphone")
		#expect(Set(properties.keys) == ["status", "numbers_bucket", "workspace_id", "actor_id", "actor_type", "surface"])
	}
}

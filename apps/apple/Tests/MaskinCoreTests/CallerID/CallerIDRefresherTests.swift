import Foundation
import Testing

@testable import MaskinCore

private final class CallerIDStubSource: CallerIDContactSource, @unchecked Sendable {
	private let lock = NSLock()
	private var contacts: [WorkObject]
	private var error: (any Error)?
	private(set) var reads = 0

	init(_ contacts: [WorkObject] = []) { self.contacts = contacts }

	func fail(_ error: (any Error)?) { lock.withLock { self.error = error } }

	func contactsWithPhone() async throws -> [WorkObject] {
		try lock.withLock {
			reads += 1
			if let error { throw error }
			return contacts
		}
	}
}

private struct CallerIDBoom: Error {}

/// A clock the test moves by hand.
private final class CallerIDTestClock: @unchecked Sendable {
	private let lock = NSLock()
	private var current = Date(timeIntervalSince1970: 1_000_000)
	var now: Date { lock.withLock { current } }
	func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

private let callerIDAda = callerIDContact("a", title: "Ada", phone: "+4512345678")

@Suite("Caller ID refresher")
struct CallerIDRefresherTests {
	private func makeRefresher(
		source: any CallerIDContactSource, store: InMemoryCallerIDListStore, clock: CallerIDTestClock
	) -> CallerIDRefresher {
		CallerIDRefresher(
			source: source, store: store, marker: InMemoryCallerIDRefreshMarker(), now: { clock.now })
	}

	@Test("The first open builds the file")
	func firstOpen() async {
		let store = InMemoryCallerIDListStore()
		let refresher = makeRefresher(source: CallerIDStubSource([callerIDAda]), store: store, clock: CallerIDTestClock())
		#expect(await refresher.refresh() == .refreshed(count: 1))
		#expect(store.load() == [CallerIDEntry(number: 4_512_345_678, label: "Ada")])
	}

	@Test("Opening again inside 24 hours does nothing, after 24 hours it refreshes")
	func throttled() async {
		let source = CallerIDStubSource([callerIDAda])
		let clock = CallerIDTestClock()
		let refresher = makeRefresher(source: source, store: InMemoryCallerIDListStore(), clock: clock)
		_ = await refresher.refresh()
		clock.advance(CallerIDRefresher.minimumInterval - 1)
		#expect(await refresher.refresh() == .skipped)
		#expect(source.reads == 1)
		clock.advance(1)
		#expect(await refresher.refresh() == .refreshed(count: 1))
		#expect(source.reads == 2)
	}

	@Test("A manual refresh ignores the 24 hours")
	func manual() async {
		let source = CallerIDStubSource([callerIDAda])
		let refresher = makeRefresher(source: source, store: InMemoryCallerIDListStore(), clock: CallerIDTestClock())
		_ = await refresher.refresh()
		#expect(await refresher.refresh(force: true) == .refreshed(count: 1))
		#expect(source.reads == 2)
	}

	@Test("A failed read keeps the old file and tries again on the next open")
	func failureKeepsOldFile() async {
		let source = CallerIDStubSource([callerIDAda])
		let store = InMemoryCallerIDListStore()
		let clock = CallerIDTestClock()
		let refresher = makeRefresher(source: source, store: store, clock: clock)
		_ = await refresher.refresh()
		clock.advance(CallerIDRefresher.minimumInterval)
		source.fail(CallerIDBoom())
		#expect(await refresher.refresh() == .failed)
		#expect(store.load()?.count == 1)
		source.fail(nil)
		#expect(await refresher.refresh() == .refreshed(count: 1))
	}

	@Test("A failed first read leaves no file and does not start the 24 hour wait")
	func firstFailure() async {
		let source = CallerIDStubSource([callerIDAda])
		source.fail(CallerIDBoom())
		let store = InMemoryCallerIDListStore()
		let refresher = makeRefresher(source: source, store: store, clock: CallerIDTestClock())
		#expect(await refresher.refresh() == .failed)
		#expect(store.load() == nil)
		source.fail(nil)
		#expect(await refresher.refresh() == .refreshed(count: 1))
	}

	@Test("Sign-out deletes the file, and the next sign-in builds it straight away")
	func wipe() async {
		let store = InMemoryCallerIDListStore()
		let refresher = makeRefresher(source: CallerIDStubSource([callerIDAda]), store: store, clock: CallerIDTestClock())
		_ = await refresher.refresh()
		await refresher.wipe()
		#expect(store.load() == nil)
		#expect(await refresher.refresh() == .refreshed(count: 1))
	}

	@Test("A refresh that was reading when the person signed out writes nothing")
	func wipeDuringRead() async {
		let gate = CallerIDReadGate()
		let store = InMemoryCallerIDListStore()
		let refresher = CallerIDRefresher(
			source: CallerIDGatedSource(gate: gate, contacts: [callerIDAda]), store: store)
		let running = Task { await refresher.refresh() }
		await gate.waitUntilEntered()
		await refresher.wipe()
		await gate.open()
		#expect(await running.value == .skipped)
		#expect(store.load() == nil)
	}
}

private actor CallerIDReadGate {
	private var entered = false
	private var opened = false
	private var waiting: CheckedContinuation<Void, Never>?

	func pass() async {
		entered = true
		if opened { return }
		await withCheckedContinuation { waiting = $0 }
	}

	func waitUntilEntered() async {
		while !entered { await Task.yield() }
	}

	func open() {
		opened = true
		waiting?.resume()
		waiting = nil
	}
}

private struct CallerIDGatedSource: CallerIDContactSource {
	let gate: CallerIDReadGate
	let contacts: [WorkObject]
	func contactsWithPhone() async throws -> [WorkObject] {
		await gate.pass()
		return contacts
	}
}

@Suite("Caller ID contact source")
struct RemoteCallerIDContactSourceTests {
	private final class CallerIDPages: @unchecked Sendable {
		private let lock = NSLock()
		private(set) var queries: [ObjectsQuery] = []
		let rows: [WorkObject]
		init(_ rows: [WorkObject]) { self.rows = rows }
		func page(_ query: ObjectsQuery) -> [WorkObject] {
			lock.withLock { queries.append(query) }
			return Array(rows.dropFirst(query.offset).prefix(query.limit))
		}
	}

	@Test("Pages through every contact in pages of 100 and keeps only the ones with a phone")
	func pages() async throws {
		// 250 contacts: every second one has a phone.
		let rows = (0..<250).map {
			callerIDContact("c\($0)", title: "Person \($0)", phone: $0 % 2 == 0 ? "+45\(10_000_000 + $0)" : nil)
		}
		let pages = CallerIDPages(rows)
		let source = RemoteCallerIDContactSource { pages.page($0) }
		let found = try await source.contactsWithPhone()
		#expect(found.count == 125)
		#expect(pages.queries.map(\.offset) == [0, 100, 200])
		#expect(pages.queries.allSatisfy { $0.type == "contact" && $0.limit == 100 })
	}

	@Test("A full last page still asks for the next, an empty one ends the walk")
	func exactMultiple() async throws {
		let rows = (0..<200).map { callerIDContact("c\($0)", title: "P\($0)", phone: "+45\(10_000_000 + $0)") }
		let pages = CallerIDPages(rows)
		let found = try await RemoteCallerIDContactSource { pages.page($0) }.contactsWithPhone()
		#expect(found.count == 200)
		#expect(pages.queries.map(\.offset) == [0, 100, 200])
	}

	@Test("A failing page fails the whole read, so a half list is never saved")
	func failure() async {
		let source = RemoteCallerIDContactSource { query in
			if query.offset > 0 { throw CallerIDBoom() }
			return (0..<100).map { callerIDContact("c\($0)", title: "P\($0)", phone: "+4510000000") }
		}
		await #expect(throws: CallerIDBoom.self) { try await source.contactsWithPhone() }
	}
}

@Suite("Caller ID file")
struct CallerIDFileStoreTests {
	private func makeStore() -> (FileCallerIDListStore, URL) {
		let directory = FileManager.default.temporaryDirectory
			.appendingPathComponent("caller-id-tests-\(UUID().uuidString)", isDirectory: true)
		return (FileCallerIDListStore(fileURL: directory.appendingPathComponent("CallerID/caller-id.json")), directory)
	}

	@Test("Saves and loads the list, and clear removes it")
	func roundTrip() throws {
		let (store, directory) = makeStore()
		defer { try? FileManager.default.removeItem(at: directory) }
		let entries = [CallerIDEntry(number: 4_512_345_678, label: "Ada"), CallerIDEntry(number: 12_025_550_123, label: "US")]
		try store.save(entries)
		#expect(store.load() == entries)
		store.clear()
		#expect(store.load() == nil)
		#expect(!FileManager.default.fileExists(atPath: store.fileURL.path))
	}

	@Test("An empty list is saved as a file, so the phone's names are replaced with none")
	func emptyList() throws {
		let (store, directory) = makeStore()
		defer { try? FileManager.default.removeItem(at: directory) }
		try store.save([])
		#expect(store.load() == [])
	}

	@Test("The file is kept out of backups")
	func excludedFromBackup() throws {
		let (store, directory) = makeStore()
		defer { try? FileManager.default.removeItem(at: directory) }
		try store.save([CallerIDEntry(number: 4_512_345_678, label: "Ada")])
		try store.save([CallerIDEntry(number: 4_512_345_678, label: "Ada")])
		let values = try store.fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
		#expect(values.isExcludedFromBackup == true)
	}

	@Test("A corrupt file, or one with a layout this build does not know, reads as no list")
	func unreadable() throws {
		let (store, directory) = makeStore()
		defer { try? FileManager.default.removeItem(at: directory) }
		try FileManager.default.createDirectory(
			at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
		try Data("not json".utf8).write(to: store.fileURL)
		#expect(store.load() == nil)
		try Data(#"{"version":99,"entries":[]}"#.utf8).write(to: store.fileURL)
		#expect(store.load() == nil)
	}
}

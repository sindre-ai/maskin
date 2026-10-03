import Foundation
import Testing

@testable import MaskinCore

private struct Row: Codable, Sendable, Equatable {
	var id: String
	var title: String
}

private final class FakeClock: @unchecked Sendable {
	private let lock = NSLock()
	private var date = Date(timeIntervalSince1970: 2_000_000)
	var now: Date {
		lock.lock()
		defer { lock.unlock() }
		return date
	}
	func advance(_ seconds: TimeInterval) {
		lock.lock()
		date = date.addingTimeInterval(seconds)
		lock.unlock()
	}
}

private func tempDirectory() -> URL {
	FileManager.default.temporaryDirectory.appendingPathComponent("diskcache-\(UUID().uuidString)")
}

private func makeCache(
	_ directory: URL, clock: FakeClock = FakeClock(), limits: DiskCache.Limits = .default
) -> DiskCache {
	DiskCache(directory: directory, limits: limits, now: { clock.now })
}

private let key = DiskCache.Key(actorId: "actor-a", workspaceId: "ws-1", name: "rows")

@Suite("DiskCache")
struct DiskCacheTests {
	@Test func roundTripsAValueWithItsSaveTime() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let clock = FakeClock()
		let cache = makeCache(dir, clock: clock)
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		let entry = cache.read([Row].self, key: key, version: 1)
		#expect(entry?.value == [Row(id: "1", title: "One")])
		#expect(entry?.savedAt == clock.now)
	}

	@Test func aMissIsNil() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		#expect(makeCache(dir).read([Row].self, key: key, version: 1) == nil)
	}

	@Test func aVersionBumpDiscardsTheEntry() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		#expect(cache.read([Row].self, key: key, version: 2) == nil)
		// Discarded for good, not just skipped.
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
		#expect(cache.totalBytes == 0)
	}

	@Test func aDecodeFailureIsAMissNotACrash() {
		struct Other: Codable, Sendable { var count: Int }
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		#expect(cache.read([Other].self, key: key, version: 1) == nil)
		#expect(cache.totalBytes == 0)
	}

	@Test func aCorruptFileIsAMiss() throws {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		let file = try #require(
			FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
				.compactMap { $0 as? URL }.first { $0.pathExtension == "cache" })
		try Data("not json".utf8).write(to: file)
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
	}

	@Test func entriesOlderThanMaxAgeExpire() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let clock = FakeClock()
		let cache = makeCache(dir, clock: clock, limits: .init(maxAge: 100))
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		clock.advance(99)
		#expect(cache.read([Row].self, key: key, version: 1) != nil)
		clock.advance(200)
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
	}

	@Test func anotherActorNeverReadsMyEntries() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "Secret")], key: key, version: 1)
		let other = DiskCache.Key(actorId: "actor-b", workspaceId: "ws-1", name: "rows")
		#expect(cache.read([Row].self, key: other, version: 1) == nil)
	}

	@Test func anotherWorkspaceNeverReadsMyEntries() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "One")], key: key, version: 1)
		let other = DiskCache.Key(actorId: "actor-a", workspaceId: "ws-2", name: "rows")
		#expect(cache.read([Row].self, key: other, version: 1) == nil)
	}

	@Test func hostileIdsCannotEscapeTheCacheDirectory() throws {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		let evil = DiskCache.Key(actorId: "../../etc", workspaceId: "../x", name: "../../y")
		cache.write([Row(id: "1", title: "One")], key: evil, version: 1)
		#expect(cache.read([Row].self, key: evil, version: 1) != nil)
		let parent = dir.deletingLastPathComponent()
		let siblings = try FileManager.default.contentsOfDirectory(atPath: parent.path)
		#expect(!siblings.contains("etc"))
	}

	@Test func clearActorRemovesOnlyThatActor() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		let b = DiskCache.Key(actorId: "actor-b", workspaceId: "ws-1", name: "rows")
		cache.write([Row(id: "1", title: "A")], key: key, version: 1)
		cache.write([Row(id: "2", title: "B")], key: b, version: 1)
		cache.clear(actorId: "actor-a")
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
		#expect(cache.read([Row].self, key: b, version: 1) != nil)
	}

	@Test func clearWorkspaceRemovesItAcrossActors() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		let b = DiskCache.Key(actorId: "actor-b", workspaceId: "ws-1", name: "rows")
		let keep = DiskCache.Key(actorId: "actor-a", workspaceId: "ws-2", name: "rows")
		cache.write([Row(id: "1", title: "A")], key: key, version: 1)
		cache.write([Row(id: "2", title: "B")], key: b, version: 1)
		cache.write([Row(id: "3", title: "C")], key: keep, version: 1)
		cache.clear(workspaceId: "ws-1")
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
		#expect(cache.read([Row].self, key: b, version: 1) == nil)
		#expect(cache.read([Row].self, key: keep, version: 1) != nil)
	}

	@Test func clearAllEmptiesTheCache() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "A")], key: key, version: 1)
		cache.clearAll()
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
		#expect(cache.totalBytes == 0)
		// Usable again afterwards.
		cache.write([Row(id: "1", title: "A")], key: key, version: 1)
		#expect(cache.read([Row].self, key: key, version: 1) != nil)
	}

	@Test func oversizedEntriesAreNotStored() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir, limits: .init(maxEntryBytes: 50))
		cache.write([Row(id: "1", title: String(repeating: "x", count: 500))], key: key, version: 1)
		#expect(cache.read([Row].self, key: key, version: 1) == nil)
	}

	@Test func theLeastRecentlyUsedEntryIsEvictedPastTheSizeBound() {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let clock = FakeClock()
		let payload = [Row(id: "1", title: String(repeating: "x", count: 400))]
		let probe = makeCache(dir, clock: clock)
		probe.write(payload, key: key, version: 1)
		let one = probe.totalBytes
		probe.clearAll()

		let cache = makeCache(dir, clock: clock, limits: .init(maxTotalBytes: one * 2 + one / 2))
		let k1 = DiskCache.Key(actorId: "a", name: "one")
		let k2 = DiskCache.Key(actorId: "a", name: "two")
		let k3 = DiskCache.Key(actorId: "a", name: "three")
		cache.write(payload, key: k1, version: 1)
		clock.advance(1)
		cache.write(payload, key: k2, version: 1)
		clock.advance(1)
		// Reading k1 makes k2 the least recently used.
		#expect(cache.read([Row].self, key: k1, version: 1) != nil)
		clock.advance(1)
		cache.write(payload, key: k3, version: 1)
		#expect(cache.read([Row].self, key: k2, version: 1) == nil)
		#expect(cache.read([Row].self, key: k1, version: 1) != nil)
		#expect(cache.read([Row].self, key: k3, version: 1) != nil)
	}

	@Test func theCacheDirectoryIsExcludedFromBackup() throws {
		let dir = tempDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let cache = makeCache(dir)
		cache.write([Row(id: "1", title: "A")], key: key, version: 1)
		let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
		#expect(values.isExcludedFromBackup == true)
	}
}

@Suite("Freshness")
struct FreshnessTests {
	@Test func hydratedDataIsStaleUntilTheNetworkConfirmsIt() {
		var f = Freshness()
		#expect(!f.isStale)
		f.hydrated(from: Date(timeIntervalSince1970: 10))
		#expect(f.isStale)
		f.refreshed(at: Date(timeIntervalSince1970: 20))
		#expect(!f.isStale)
		#expect(f.updatedAt == Date(timeIntervalSince1970: 20))
	}

	@Test func aFailedRevalidateKeepsTheTimestampButIsStale() {
		var f = Freshness()
		f.refreshed(at: Date(timeIntervalSince1970: 20))
		f.revalidateFailed()
		#expect(f.isStale)
		#expect(f.updatedAt == Date(timeIntervalSince1970: 20))
	}

	@Test func labelsReadNaturally() {
		var f = Freshness()
		#expect(f.label() == nil)
		f.refreshed(at: Date(timeIntervalSince1970: 1000))
		#expect(f.label(now: Date(timeIntervalSince1970: 1010)) == "Updated just now")
		#expect(f.label(now: Date(timeIntervalSince1970: 1000 + 600))?.hasPrefix("Updated ") == true)
	}
}

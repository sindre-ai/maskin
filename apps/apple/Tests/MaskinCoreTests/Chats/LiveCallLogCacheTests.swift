import Foundation
import Testing

@testable import MaskinCore

@Suite("LiveCallLog decode cache")
@MainActor
struct LiveCallLogCacheTests {
	private func defaults() -> UserDefaults { UserDefaults(suiteName: "livecalllog-\(UUID().uuidString)")! }

	private func record(_ id: String, spoken: [String] = []) -> LiveCallRecord {
		LiveCallRecord(
			id: id, conversationID: "c1", leadName: "Relay", startedAt: Date(timeIntervalSince1970: 100),
			spoken: spoken)
	}

	@Test("repeated reads return the saved records")
	func repeatedReads() {
		let log = LiveCallLog(defaults: defaults())
		log.save(record("a", spoken: ["hello"]))
		#expect(log.all().map(\.id) == ["a"])
		#expect(log.all().map(\.id) == ["a"])
		#expect(log.records(for: "c1").first?.spoken == ["hello"])
		#expect(log.records(for: "other").isEmpty)
	}

	@Test("a save through this log is seen by the next read")
	func ownWritesAreSeen() {
		let log = LiveCallLog(defaults: defaults())
		log.save(record("a"))
		_ = log.all()
		log.save(record("b"))
		#expect(log.all().map(\.id) == ["a", "b"])
		log.update("a") { $0.expanded = true }
		#expect(log.all().first?.expanded == true)
	}

	@Test("a write through another instance over the same defaults is seen, not served stale")
	func otherInstanceWritesAreSeen() {
		let suite = defaults()
		let reader = LiveCallLog(defaults: suite)
		let writer = LiveCallLog(defaults: suite)
		#expect(reader.all().isEmpty)
		writer.save(record("a"))
		#expect(reader.all().map(\.id) == ["a"])
		writer.save(record("b"))
		#expect(reader.all().map(\.id) == ["a", "b"])
	}

	@Test("removed or corrupt data reads as empty")
	func removedOrCorrupt() {
		let suite = defaults()
		let log = LiveCallLog(defaults: suite)
		log.save(record("a"))
		#expect(log.all().count == 1)
		suite.removeObject(forKey: "live.calls.v1")
		#expect(log.all().isEmpty)
		suite.set(Data("not json".utf8), forKey: "live.calls.v1")
		#expect(log.all().isEmpty)
	}
}

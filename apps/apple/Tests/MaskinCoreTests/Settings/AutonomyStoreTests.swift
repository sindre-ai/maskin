import Foundation
import Testing

@testable import MaskinCore

private final class MemoryAutonomyStorage: AutonomyStoring, @unchecked Sendable {
	private let lock = NSLock()
	private var values: [String: AutonomyLevel] = [:]
	func level(for key: String) -> AutonomyLevel? { lock.withLock { values[key] } }
	func save(_ level: AutonomyLevel, for key: String) { lock.withLock { values[key] = level } }
}

@MainActor
@Suite("AutonomyStore")
struct AutonomyStoreTests {
	@Test func startsAtRoutineOnly() {
		let store = AutonomyStore(workspaceID: "w", actorID: "a", storage: MemoryAutonomyStorage())
		#expect(store.level == .routineOnly)
		#expect(store.changeLine == nil)
	}

	@Test func changingLevelSaysWhatChanges() {
		let store = AutonomyStore(workspaceID: "w", actorID: "a", storage: MemoryAutonomyStorage())
		store.select(.askOnlyWhenStuck)
		#expect(
			store.changeLine
				== "From now on, everything except blocked steps and spending is decided without you.")
		store.select(.askFirst)
		#expect(store.changeLine == "From now on, nothing is decided without you.")
	}

	@Test func choosingTheCurrentLevelChangesNothing() {
		let store = AutonomyStore(workspaceID: "w", actorID: "a", storage: MemoryAutonomyStorage())
		store.select(.routineOnly)
		#expect(store.changeLine == nil)
	}

	@Test func theLevelIsPerUserAndPerWorkspace() {
		let storage = MemoryAutonomyStorage()
		AutonomyStore(workspaceID: "w1", actorID: "a", storage: storage).select(.askFirst)
		#expect(AutonomyStore(workspaceID: "w1", actorID: "a", storage: storage).level == .askFirst)
		#expect(AutonomyStore(workspaceID: "w2", actorID: "a", storage: storage).level == .routineOnly)
		#expect(AutonomyStore(workspaceID: "w1", actorID: "b", storage: storage).level == .routineOnly)
	}
}

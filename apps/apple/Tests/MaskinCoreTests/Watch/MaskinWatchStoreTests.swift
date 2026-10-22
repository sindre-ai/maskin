import Foundation
import Testing

@testable import MaskinCore

private struct StubSource: WatchSnapshotSource {
	var result: Result<WatchSnapshot, any Error>
	func fetch() async throws -> WatchSnapshot { try result.get() }
}

private func snapshot(_ cards: Int, at seconds: TimeInterval) -> WatchSnapshot {
	WatchSnapshot(
		cards: (0..<cards).map { WatchSnapshot.Card(id: "c\($0)", sender: "Forge", headline: "Ask \($0)") },
		flows: [], updatedAt: Date(timeIntervalSince1970: seconds))
}

@MainActor
@Suite("MaskinWatchStore")
struct MaskinWatchStoreTests {
	@Test("starts from the cached snapshot so a cold launch offline is not blank")
	func coldLaunch() {
		let store = MaskinWatchStore(storage: InMemoryWatchSnapshotStorage(snapshot(2, at: 10)))
		#expect(store.needsCount == 2)
		#expect(store.origin == .cache)
	}

	@Test("a phone snapshot is shown and cached")
	func phone() {
		let storage = InMemoryWatchSnapshotStorage()
		let store = MaskinWatchStore(storage: storage)
		store.receive(fromPhone: snapshot(3, at: 20))
		#expect(store.cards.count == 3)
		#expect(store.origin == .phone)
		#expect(storage.load()?.cards.count == 3)
	}

	@Test("a stale phone context never replaces a newer snapshot")
	func staleIgnored() {
		let store = MaskinWatchStore(storage: InMemoryWatchSnapshotStorage())
		store.publish(snapshot(4, at: 50))
		store.receive(fromPhone: snapshot(1, at: 40))
		#expect(store.needsCount == 4)
		#expect(store.origin == .network)
	}

	@Test("refresh adopts the fetched snapshot")
	func refresh() async {
		let store = MaskinWatchStore(
			source: StubSource(result: .success(snapshot(5, at: 60))), storage: InMemoryWatchSnapshotStorage())
		await store.refresh()
		#expect(store.needsCount == 5)
		#expect(!store.isOffline)
	}

	@Test("a failed refresh keeps the last snapshot and says it is offline")
	func refreshFails() async {
		let store = MaskinWatchStore(
			source: StubSource(result: .failure(URLError(.notConnectedToInternet))),
			storage: InMemoryWatchSnapshotStorage(snapshot(2, at: 10)))
		await store.refresh()
		#expect(store.needsCount == 2)
		#expect(store.isOffline)
	}

	@Test("change callback fires so complications can reload")
	func onChange() {
		var seen: [Int] = []
		let store = MaskinWatchStore(storage: InMemoryWatchSnapshotStorage(), onChange: { seen.append($0.needsCount) })
		store.publish(snapshot(2, at: 5))
		#expect(seen == [2])
	}

	@Test("clear forgets the account")
	func clear() {
		let storage = InMemoryWatchSnapshotStorage(snapshot(2, at: 10))
		let store = MaskinWatchStore(storage: storage)
		store.clear()
		#expect(store.snapshot == nil)
		#expect(storage.load()?.cards.isEmpty == true)
	}
}

@Suite("WatchSnapshot")
struct WatchSnapshotTests {
	@Test("round-trips through the application context")
	func roundTrip() {
		let original = WatchSnapshot(
			cards: [.init(id: "1", sender: "Forge", headline: "Ship?", options: [DecisionOption(label: "Ship", recommended: true)])],
			flows: [.init(id: "f", name: "Outreach", progress: 0.4, paused: false, needsYou: true, cycleStage: "Cycle 2 \u{00B7} Learning")],
			briefing: "Hi", firstName: "Ada", updatedAt: Date(timeIntervalSince1970: 100))
		#expect(WatchSnapshot(context: original.context()) == original)
	}

	@Test("a context without a snapshot decodes to nil")
	func missing() {
		#expect(WatchSnapshot(context: [:]) == nil)
		#expect(WatchSnapshot(context: [WatchSnapshot.contextKey: Data([1, 2])]) == nil)
	}

	@Test("a snapshot-only context does not read as a sign-out; an empty or marked one does")
	func handoffDecode() {
		let snapshotOnly = WatchSnapshot(updatedAt: .now).context()
		#expect(WatchHandoff.decode(context: snapshotOnly) == nil)
		#expect(WatchHandoff.decode(context: [:])?.session == nil)
		#expect(WatchHandoff.decode(context: [WatchHandoff.signedOutKey: true])?.session == nil)
	}

	@Test("flow summary carries cycle, stage, target and the latest sentence")
	func flowSummary() {
		let loop = LoopSummary(
			id: "l", name: "Outreach", content: "Replies are up. More tomorrow.", status: .supervised,
			inProgressCount: 2, closedCount: 3, waitingCount: 1,
			targets: [LoopTarget(label: "Replies", actual: 12, target: 20)])
		let flow = WatchSnapshotBuilder.flow(loop)
		#expect(flow.cycleStage == "Cycle 4 \u{00B7} Supervised")
		#expect(flow.target == "Replies 12 of 20")
		#expect(flow.latest == "Replies are up.")
		#expect(flow.needsYou)
	}
}

@Suite("WatchNotificationPlan")
struct WatchNotificationPlanTests {
	private func payload(_ options: [PushDecisionOption]) -> PushDecisionPayload {
		PushDecisionPayload(
			workspaceId: "w", notificationId: "n", eventId: 1, objectId: "o", options: options)
	}

	@Test("recommended first, Hold second, indices kept")
	func order() {
		let plan = WatchNotificationPlan(
			payload([
				PushDecisionOption(label: "Revise"), PushDecisionOption(label: "Hold"),
				PushDecisionOption(label: "Send 7", recommended: true),
			]))
		#expect(plan.actions.map(\.title) == ["Send 7", "Hold"])
		#expect(plan.actions.map(\.identifier) == ["maskin.option.2", "maskin.option.1"])
		#expect(plan.categoryIdentifier == "decision.n")
	}

	@Test("without a Hold the second action is the next option")
	func noHold() {
		let plan = WatchNotificationPlan(payload([PushDecisionOption(label: "A"), PushDecisionOption(label: "B")]))
		#expect(plan.actions.map(\.title) == ["A", "B"])
	}
}

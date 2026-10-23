import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

@MainActor
private final class SweepHost: AgentsActivityHosting {
	var live: [AgentsActivityCard] = []
	var ended: [String] = []

	func activeIdentity() -> AgentsActivityIdentity? {
		live.first.map { AgentsActivityIdentity(workspaceId: $0.workspaceId) }
	}
	func start(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {
		live.append(.init(id: "new", workspaceId: identity.workspaceId))
	}
	func update(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {}
	func end(_ identity: AgentsActivityIdentity, state: AgentsActivityState, dismissAfter: TimeInterval) async {
		live = []
	}
	func endAll() async { live = [] }
	func cards() -> [AgentsActivityCard] { live }
	func endNow(cardID: String) async {
		ended.append(cardID)
		live.removeAll { $0.id == cardID }
	}
}

private struct NoTokens: LiveActivityTokenRegistering {
	func register(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String)
		async throws -> String { "t" }
	func unregister(tokenId: String, credentials: APILiveActivityTokens.Credentials?) async throws {}
}

private func card(_ id: String, _ ws: String = "ws") -> AgentsActivityCard {
	AgentsActivityCard(id: id, workspaceId: ws)
}

@Suite("AgentsActivitySweep plan")
struct AgentsActivitySweepPlanTests {
	@Test func otherWorkspaceCardsEndEvenBeforeTheFeedLoads() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("a", "old"), card("b")], workspaceId: "ws", feedLoaded: false, hasWorkingAgents: false)
		#expect(plan.ends == [.init(cardID: "a", reason: .otherWorkspace)])
	}

	@Test func signedOutEndsEveryCard() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("a")], workspaceId: nil, feedLoaded: true, hasWorkingAgents: false)
		#expect(plan.ends == [.init(cardID: "a", reason: .otherWorkspace)])
	}

	@Test func anUnloadedFeedNeverEndsALiveCard() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("a")], workspaceId: "ws", feedLoaded: false, hasWorkingAgents: false)
		#expect(plan.ends.isEmpty)
	}

	@Test func aLoadedFeedWithNobodyWorkingEndsTheOrphan() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("a"), card("b")], workspaceId: "ws", feedLoaded: true, hasWorkingAgents: false)
		#expect(Set(plan.ends.map(\.reason)) == [.nothingWorking])
		#expect(plan.ends.map(\.cardID) == ["a", "b"])
	}

	@Test func duplicatesCollapseToTheLowestId() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("c"), card("a"), card("b")], workspaceId: "ws", feedLoaded: true, hasWorkingAgents: true)
		#expect(plan.ends == [.init(cardID: "b", reason: .duplicate), .init(cardID: "c", reason: .duplicate)])
	}

	@Test func aSingleCardWithAgentsWorkingStays() {
		let plan = AgentsActivitySweep.plan(
			cards: [card("a")], workspaceId: "ws", feedLoaded: true, hasWorkingAgents: true)
		#expect(plan.ends.isEmpty)
	}
}

@MainActor
@Suite("AgentsActivityCoordinator sweep")
struct AgentsActivityCoordinatorSweepTests {
	private func make(cards: [AgentsActivityCard]) -> (AgentsActivityCoordinator, SweepHost) {
		let host = SweepHost()
		host.live = cards
		return (AgentsActivityCoordinator(host: host, tokens: NoTokens(), now: { t0 }), host)
	}

	@Test func anOrphanedCardIsEndedOnceTheFeedSaysNobodyWorks() async {
		let (coordinator, host) = make(cards: [card("orphan")])
		await coordinator.workspaceChanged("ws")
		host.live = [card("orphan")]  // workspaceChanged ends everything; the push-started card arrives after
		await coordinator.sweep()
		#expect(host.ended.isEmpty, "feed not loaded yet: unknown, not empty")
		await coordinator.feedChanged([])
		await coordinator.sweep()
		#expect(host.live.isEmpty)
	}

	@Test func aCardForWorkingAgentsSurvivesTheSweep() async {
		let (coordinator, host) = make(cards: [])
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([WorkingAgent(id: "a", sessionId: "s", name: "Forge", startedAt: t0)])
		await coordinator.sweep()
		#expect(host.ended.isEmpty)
		#expect(host.live.count == 1)
	}

	@Test func staleCardsFromAnotherWorkspaceAreEnded() async {
		let (coordinator, host) = make(cards: [])
		await coordinator.workspaceChanged("ws")
		host.live = [card("x", "old")]
		await coordinator.sweep()
		#expect(host.ended == ["x"])
	}
}

@Suite("WorkingAgent topic")
struct WorkingAgentTopicTests {
	@Test func topicIsTrimmedAndBlankMeansNone() {
		let blank = WorkingAgent(id: "a", sessionId: "s", name: "A", startedAt: t0, topic: "  \n ")
		let named = WorkingAgent(id: "a", sessionId: "s", name: "A", startedAt: t0, topic: "  Q3 launch ")
		#expect(blank.topic == nil)
		#expect(named.topic == "Q3 launch")
	}

	@Test func longTopicsAreCut() {
		let agent = WorkingAgent(
			id: "a", sessionId: "s", name: "A", startedAt: t0, topic: String(repeating: "x", count: 200))
		#expect(agent.topic?.count == WorkingAgent.maxTopicLength)
	}

	@Test func aPayloadWithoutTopicStillDecodes() throws {
		let agent = WorkingAgent(id: "a", sessionId: "s", name: "A", startedAt: t0, topic: "T")
		var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(agent)) as! [String: Any]
		json["topic"] = nil
		let back = try JSONDecoder().decode(WorkingAgent.self, from: JSONSerialization.data(withJSONObject: json))
		#expect(back.topic == nil)
	}

	@Test func turnsCarryTheConversationTitleToTheCard() {
		let session = ChatAgentSession(id: "s1", actorID: "a", status: .running, startedAt: t0)
		let turns = LiveTurn.turns(
			from: [session], workspaceId: "ws", conversationId: "c", agentName: { _ in "Forge" },
			topic: "Pricing page", now: t0)
		#expect(turns.first?.workingAgent?.topic == "Pricing page")
	}
}

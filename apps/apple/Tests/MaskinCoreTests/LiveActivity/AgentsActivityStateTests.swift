import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

private func agent(
	_ id: String, name: String? = nil, doing: String? = "working", started: TimeInterval = 0,
	finish: TimeInterval? = nil, customers: Bool = false, object: String? = nil, conversation: String? = nil
) -> WorkingAgent {
	WorkingAgent(
		id: id, sessionId: "s-\(id)", name: name ?? id.capitalized, doing: doing,
		startedAt: t0.addingTimeInterval(started),
		expectedFinishAt: finish.map { t0.addingTimeInterval($0) },
		touchesCustomersOrProduction: customers, objectId: object, conversationId: conversation)
}

@Suite("WorkingAgent")
struct WorkingAgentTests {
	@Test func clampsAndDefaultsTheContractFields() {
		let long = WorkingAgent(
			id: "a", sessionId: "s", name: String(repeating: "n", count: 90),
			doing: String(repeating: "x", count: 200), startedAt: t0)
		#expect(long.name.count == WorkingAgent.maxNameLength)
		#expect(long.doing.count == WorkingAgent.maxDoingLength)
		let blank = WorkingAgent(id: "a", sessionId: "s", name: "  ", doing: " ", startedAt: t0)
		#expect(blank.name == "Agent")
		#expect(blank.doing == "working")
	}

	@Test func initialsMatchTheAvatarRule() {
		#expect(WorkingAgent.initials(for: "Chief of Staff") == "CO")
		#expect(WorkingAgent.initials(for: "Forge") == "FO")
		#expect(WorkingAgent.initials(for: "") == "?")
		#expect(WorkingAgent.initials(for: "(Writer)") == "WR")
	}

	@Test func sentenceLowersACapitalisedStepButKeepsNames() {
		#expect(agent("forge", name: "Forge", doing: "Reading files").sentence == "Forge is reading files")
		#expect(agent("forge", name: "Forge", doing: "rolling out Retry policy v2").sentence == "Forge is rolling out Retry policy v2")
		#expect(agent("forge", name: "Forge", doing: "API sweep").sentence == "Forge is API sweep")
		#expect(agent("forge", name: "Forge", doing: "LinkedIn outreach").sentence == "Forge is LinkedIn outreach")
	}

	@Test func timeLeftRoundsUpAndNeverReadsZero() {
		let soon = agent("a", finish: 30)
		#expect(soon.minutesLeft(now: t0) == 1)
		#expect(soon.timeLeftText(now: t0) == "1 min left")
		#expect(agent("a", finish: 14 * 60 + 1).minutesLeft(now: t0) == 15)
		#expect(agent("a", finish: -120).minutesLeft(now: t0) == 1)
		#expect(agent("a").timeLeftText(now: t0) == nil)
	}

	@Test func finishesSoonIsWithinFifteenMinutesIncludingOverdue() {
		#expect(agent("a", finish: 15 * 60).finishesSoon(now: t0))
		#expect(!agent("a", finish: 15 * 60 + 1).finishesSoon(now: t0))
		#expect(agent("a", finish: -60).finishesSoon(now: t0))
		#expect(!agent("a").finishesSoon(now: t0))
	}

	@Test func openPrefersTheObjectThenTheThreadThenTheAgent() {
		#expect(DeepLink(url: agent("a", object: "o1", conversation: "c1").openURL(workspaceId: "ws")) == .object(workspaceId: "ws", id: "o1"))
		#expect(DeepLink(url: agent("a", conversation: "c1").openURL(workspaceId: "ws")) == .chat(workspaceId: "ws", id: "c1"))
		#expect(DeepLink(url: agent("a").openURL(workspaceId: "ws")) == .agent(workspaceId: "ws", id: "a"))
	}
}

@Suite("AgentsActivityState")
struct AgentsActivityStateTests {
	@Test func ranksSoonestFinishThenCustomersThenLongestRunning() {
		let state = AgentsActivityState(
			agents: [
				agent("idle-new", started: -60),
				agent("idle-old", started: -600),
				agent("customers", started: -30, customers: true),
				agent("later", finish: 40 * 60),
				agent("soon", finish: 5 * 60),
			], now: t0)
		#expect(state.agents.map(\.id) == ["soon", "later", "customers", "idle-old", "idle-new"])
	}

	@Test func rankingIsStableForTies() {
		let a = AgentsActivityState(agents: [agent("b"), agent("a")], now: t0)
		let b = AgentsActivityState(agents: [agent("a"), agent("b")], now: t0)
		#expect(a == b)
		#expect(a.agents.map(\.id) == ["a", "b"])
	}

	@Test func countsTheWholeSetButCarriesOnlyTheTopRows() {
		let many = (0..<10).map { agent("a\($0)", finish: Double($0) * 60) }
		let state = AgentsActivityState(agents: many, now: t0)
		#expect(state.count == 10)
		#expect(state.agents.count == AgentsActivityState.maxEncodedAgents)
		#expect(state.finishingSoon == 10)
		#expect(state.top.map(\.id) == ["a0", "a1", "a2"])
	}

	@Test func headlineCopy() {
		#expect(AgentsActivityState.empty.headline(now: t0) == "Agents finished")
		let one = AgentsActivityState(agents: [agent("forge", name: "Forge", doing: "rolling out Retry policy v2")], now: t0)
		#expect(one.headline(now: t0) == "Forge is rolling out Retry policy v2")
		let several = AgentsActivityState(
			agents: [
				agent("a", finish: 4 * 60), agent("b", finish: 15 * 60), agent("c", finish: 9 * 60),
				agent("d", finish: 50 * 60), agent("e"),
			], now: t0)
		#expect(several.headline(now: t0) == "5 agents working · 3 finish in 15 min")
		let unknown = AgentsActivityState(agents: [agent("a"), agent("b")], now: t0)
		#expect(unknown.headline(now: t0) == "2 agents working")
	}

	@Test func pauseLabelNamesTheThingForOneAgent() {
		let one = AgentsActivityState(agents: [agent("forge", doing: "Rolling out Retry policy v2")], now: t0)
		#expect(one.pauseLabel == "Pause rolling out")
		#expect(AgentsActivityState(agents: [agent("a"), agent("b")], now: t0).pauseLabel == "Pause all")
	}

	@Test func encodesTheBackendContractShape() throws {
		let state = AgentsActivityState(
			agents: [agent("forge", name: "Forge", doing: "drafting", finish: 600, customers: true, object: "o1")], now: t0)
		let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
		#expect(Set(json.keys) == ["count", "finishingSoon", "agents"])
		let row = try #require((json["agents"] as? [[String: Any]])?.first)
		#expect(
			Set(row.keys)
				== ["id", "sessionId", "name", "doing", "startedAt", "expectedFinishAt", "touchesCustomersOrProduction", "objectId"])
		// Default Date coding: seconds since 2001, NOT unix epoch.
		#expect(row["startedAt"] as? Double == 800_000_000)
		#expect(row["expectedFinishAt"] as? Double == 800_000_600)
		#expect(row["touchesCustomersOrProduction"] as? Bool == true)
	}

	@Test func roundTripsThroughJSON() throws {
		let state = AgentsActivityState(
			agents: [agent("a", finish: 60, customers: true, conversation: "c1"), agent("b")], now: t0)
		let back = try JSONDecoder().decode(AgentsActivityState.self, from: JSONEncoder().encode(state))
		#expect(back == state)
	}

	@Test func decodesAMinimalServerPayload() throws {
		let raw = Data(
			#"{"agents":[{"id":"a1","sessionId":"s1","name":"Forge","doing":"working","startedAt":800000000.0,"touchesCustomersOrProduction":false}]}"#
				.utf8)
		let state = try JSONDecoder().decode(AgentsActivityState.self, from: raw)
		#expect(state.count == 1)
		#expect(state.finishingSoon == 0)
		#expect(state.agents.first?.startedAt == t0)
	}
}

@Suite("AgentsActivityIdentity")
struct AgentsActivityIdentityTests {
	@Test func keyAndSeeAllLink() {
		let identity = AgentsActivityIdentity(workspaceId: "ws")
		#expect(identity.activityID == "agents-working:ws")
		#expect(DeepLink(url: identity.seeAllURL) == .agents(workspaceId: "ws"))
	}
}

@Suite("LiveTurn mapping")
struct LiveTurnTests {
	private func session(
		_ id: String, status: ChatAgentSession.Status, activity: String? = nil, actor: String = "a1"
	) -> ChatAgentSession {
		ChatAgentSession(id: id, actorID: actor, status: status, currentActivity: activity, startedAt: t0)
	}

	private func map(_ sessions: [ChatAgentSession], replyInFlight: Bool = true) -> [LiveTurn] {
		LiveTurn.turns(
			from: sessions, workspaceId: "ws", conversationId: "c1",
			agentName: { $0 == "a1" ? "Forge" : nil }, now: t0, replyInFlight: replyInFlight)
	}

	@Test func mapsSessionStatuses() {
		let turns = map([
			session("1", status: .running, activity: "Reading files"), session("2", status: .starting),
			session("3", status: .paused), session("4", status: .completed),
			session("5", status: .timeout), session("6", status: .other("weird")),
		])
		#expect(turns.map(\.status) == [.running, .running, .needsYou, .done, .failed])
		#expect(turns.first?.step == "Reading files")
		#expect(turns.first?.agentName == "Forge")
	}

	@Test func aUserStoppedSessionIsDoneNotDropped() {
		let turns = map([session("1", status: .other("user_stopped"))])
		#expect(turns.map(\.status) == [.done])
		#expect(turns.compactMap(\.workingAgent).isEmpty)
	}

	@Test func aRunningChatSessionWithNoReplyOwedIsIdle() {
		#expect(map([session("1", status: .running), session("2", status: .paused)], replyInFlight: false).map(\.status) == [.done, .needsYou])
	}

	@Test func aChatSessionThatWentQuietIsIdle() {
		let quiet = ChatAgentSession(
			id: "1", actorID: "a1", status: .running, startedAt: t0.addingTimeInterval(-3600),
			updatedAt: t0.addingTimeInterval(-LiveTurn.staleAfter - 1))
		let fresh = ChatAgentSession(id: "2", actorID: "a1", status: .running, startedAt: t0.addingTimeInterval(-3600), updatedAt: t0.addingTimeInterval(-60))
		#expect(map([quiet, fresh]).map(\.status) == [.done, .running])
	}

	@Test func onlyRunningTurnsBecomeAgentsAndDecisionsNever() {
		let turns = map([session("1", status: .running, activity: "Reading"), session("2", status: .paused), session("3", status: .completed)])
		let agents = turns.compactMap(\.workingAgent)
		#expect(agents.count == 1)
		#expect(agents.first?.id == "a1")
		#expect(agents.first?.sessionId == "1")
		#expect(agents.first?.conversationId == "c1")
		#expect(agents.first?.doing == "Reading")
	}

	@Test func unresolvedAgentNeverShowsAnId() {
		#expect(map([session("1", status: .running, actor: "9f1c-uuid")])[0].agentName == "Agent")
	}
}

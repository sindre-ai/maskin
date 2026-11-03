import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("WorkingAgentsFeed")
struct WorkingAgentsFeedTests {
	@Test func mapsNonInteractiveLiveSessionsOnePerAgent() {
		let sessions = [
			agentSession("s1", actor: "forge", status: "running", at: -300, activity: "Reading"),
			agentSession("s2", actor: "forge", status: "starting", at: -10),
			agentSession("s3", actor: "writer", status: "running", at: -60),
			agentSession("s4", actor: "chat", status: "running", at: -60).interactive(),
			agentSession("s5", actor: "done", status: "completed", at: -60),
			agentSession("s6", actor: "paused", status: "paused", at: -60),
		]
		let agents = WorkingAgentsFeed.agents(from: sessions, names: ["forge": "Forge"], now: agentT0)
		#expect(agents.map(\.id) == ["forge", "writer"])
		#expect(agents[0].sessionId == "s1")  // the one that started first
		#expect(agents[0].name == "Forge")
		#expect(agents[0].doing == "Reading")
		#expect(agents[1].name == "Agent")  // unknown actor: never an id
		#expect(agents[1].doing == "working")
	}

	@Test func refreshReportsOnlyChanges() async {
		let api = FakeAgentsAPI(
			[agentRow("forge", name: "Forge")], sessions: [agentSession("s1", actor: "forge", status: "running")])
		let box = ChangeBox()
		let feed = WorkingAgentsFeed(api: api, events: nil, now: { agentT0 }) { agents in box.changes.append(agents) }
		await feed.refresh()
		await feed.refresh()
		#expect(box.changes.count == 1)
		#expect(box.changes.first?.map(\.name) == ["Forge"])
		await api.set(sessions: [])
		await feed.refresh()
		#expect(box.changes.count == 2)
		#expect(box.changes.last?.isEmpty == true)
	}

	@Test func aFailedFetchKeepsTheLastResult() async {
		let api = FakeAgentsAPI(
			[agentRow("forge")], sessions: [agentSession("s1", actor: "forge", status: "running")])
		let box = ChangeBox()
		let feed = WorkingAgentsFeed(api: api, events: nil, now: { agentT0 }) { agents in box.changes.append(agents) }
		await feed.refresh()
		await api.setFailing(true)
		await feed.refresh()
		#expect(box.changes.count == 1)
		#expect(feed.agents.count == 1)
	}

	@Test func aHubRefreshRequestRefetches() async {
		let api = FakeAgentsAPI([agentRow("forge")], sessions: [])
		let hub = EventHub(client: nil)
		let box = ChangeBox()
		let feed = WorkingAgentsFeed(api: api, events: hub, now: { agentT0 }) { agents in box.changes.append(agents) }
		await feed.start()
		#expect(box.changes.count == 1)
		await api.set(sessions: [agentSession("s1", actor: "forge", status: "running")])
		hub.requestRefresh()
		#expect(await eventually { box.changes.count == 2 })
		#expect(box.changes.last?.map(\.id) == ["forge"])
		feed.stop()
	}
}

@MainActor
private final class ChangeBox {
	var changes: [[WorkingAgent]] = []
}

extension AgentSession {
	fileprivate func interactive() -> AgentSession {
		var copy = self
		copy.interactive = true
		return copy
	}
}

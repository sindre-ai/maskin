import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

@MainActor
private final class FakeFollowHost: FollowActivityHosting {
	var log: [String] = []
	var states: [FollowActivityState] = []
	var existing: Set<String> = []

	func start(_ target: FollowTarget, state: FollowActivityState) {
		log.append("start:\(target.sessionId)")
		states.append(state)
	}
	func update(sessionId: String, state: FollowActivityState) async {
		log.append("update:\(sessionId)")
		states.append(state)
	}
	func end(sessionId: String, state: FollowActivityState?, dismissAfter: TimeInterval) async {
		log.append("end:\(sessionId):\(Int(dismissAfter))")
		if let state { states.append(state) }
	}
	func activeSessionIds() -> Set<String> { existing }
	func endAll() async { log.append("endAll") }
}

private func agent(_ id: String, doing: String = "running the booking tests", topic: String? = nil)
	-> WorkingAgent
{
	WorkingAgent(
		id: id, sessionId: "s-\(id)", name: id.capitalized, doing: doing, startedAt: t0, conversationId: "c-\(id)",
		topic: topic)
}

@Suite("FollowActivityState")
struct FollowActivityStateTests {
	@Test("The title joins the agent and the topic, and drops a missing topic")
	func title() {
		#expect(FollowActivityState(following: agent("developer", topic: "Webhook dedup fix")).title
			== "Developer \u{00B7} Webhook dedup fix")
		#expect(FollowActivityState(following: agent("developer")).title == "Developer")
	}

	@Test("The now line lowers a capitalised step")
	func nowLine() {
		#expect(FollowActivityState(following: agent("developer", doing: "Running the tests")).nowLine
			== "Now: running the tests")
	}

	@Test("The open link goes to the object, else the chat, else the agent")
	func openURL() {
		let withObject = FollowTarget(sessionId: "s", workspaceId: "w", agentId: "a", objectId: "o", conversationId: "c")
		let withChat = FollowTarget(sessionId: "s", workspaceId: "w", agentId: "a", conversationId: "c")
		let bare = FollowTarget(sessionId: "s", workspaceId: "w", agentId: "a")
		#expect(withObject.openURL == DeepLink.object(workspaceId: "w", id: "o").url)
		#expect(withChat.openURL == DeepLink.chat(workspaceId: "w", id: "c").url)
		#expect(bare.openURL == DeepLink.agent(workspaceId: "w", id: "a").url)
	}

	@Test("State survives a Codable round trip")
	func codable() throws {
		let state = FollowActivityState(following: agent("developer", topic: "Fix"))
		let data = try JSONEncoder().encode(state)
		#expect(try JSONDecoder().decode(FollowActivityState.self, from: data) == state)
	}
}

@MainActor
@Suite("FollowActivityController")
struct FollowActivityControllerTests {
	@Test("Follow starts one card per session and needs a workspace")
	func follow() async {
		let host = FakeFollowHost()
		let controller = FollowActivityController(host: host)
		controller.follow(agent("developer"))
		#expect(host.log.isEmpty)
		await controller.workspaceChanged("w")
		controller.follow(agent("developer"))
		controller.follow(agent("developer"))
		#expect(host.log == ["start:s-developer"])
		#expect(controller.isFollowing("s-developer"))
	}

	@Test("A changed step updates the card; an unchanged one does not")
	func update() async {
		let host = FakeFollowHost()
		let controller = FollowActivityController(host: host)
		await controller.workspaceChanged("w")
		controller.follow(agent("developer"))
		await controller.workingChanged([agent("developer")])
		await controller.workingChanged([agent("developer", doing: "opening the pull request")])
		#expect(host.log == ["start:s-developer", "update:s-developer"])
	}

	@Test("A followed session that leaves the working set finishes and lingers fifteen minutes")
	func finishes() async {
		let host = FakeFollowHost()
		let controller = FollowActivityController(host: host)
		await controller.workspaceChanged("w")
		controller.follow(agent("developer"))
		await controller.workingChanged([agent("other")])
		#expect(host.log.last == "end:s-developer:900")
		#expect(host.states.last?.phase == .finished)
		#expect(!controller.isFollowing("s-developer"))
	}

	@Test("Stop following removes the card at once")
	func stop() async {
		let host = FakeFollowHost()
		let controller = FollowActivityController(host: host)
		await controller.workspaceChanged("w")
		controller.follow(agent("developer"))
		await controller.stopFollowing(sessionId: "s-developer")
		#expect(host.log.last == "end:s-developer:0")
		#expect(!controller.isFollowing("s-developer"))
	}

	@Test("Switching workspace ends the old cards; the first workspace adopts cards left behind")
	func workspaces() async {
		let host = FakeFollowHost()
		host.existing = ["s-left"]
		let controller = FollowActivityController(host: host)
		await controller.workspaceChanged("w")
		#expect(controller.isFollowing("s-left"))
		await controller.workspaceChanged("w2")
		#expect(host.log.contains("endAll"))
		await controller.workspaceChanged(nil)
		#expect(!controller.isFollowing("s-left"))
	}
}

import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ObjectSessionCopy")
struct ObjectSessionCopyTests {
	private func session(_ status: String, reason: String? = nil) -> ObjectSession {
		ObjectSession(id: "s", status: status, agentID: "a", failureReason: reason, createdByActorID: "u")
	}

	@Test("names the session's agent, or says an agent")
	func working() {
		#expect(ObjectSessionCopy.workingTitle(agentName: "Developer") == "Developer is working")
		#expect(ObjectSessionCopy.workingTitle(agentName: nil) == "An agent is working")
	}

	@Test("failed card shows only for a failed session with nothing running")
	func failedVisibility() {
		#expect(ObjectSessionCopy.showsFailed(session("failed"), hasActiveSession: false))
		#expect(ObjectSessionCopy.showsFailed(session("timeout"), hasActiveSession: false))
		#expect(!ObjectSessionCopy.showsFailed(session("failed"), hasActiveSession: true))
		#expect(!ObjectSessionCopy.showsFailed(session("completed"), hasActiveSession: false))
		#expect(!ObjectSessionCopy.showsFailed(nil, hasActiveSession: false))
	}

	@Test("failed title carries the reason when there is one")
	func failedTitle() {
		#expect(ObjectSessionCopy.failedTitle(agentName: "SEO", reason: "403") == "SEO stopped: 403")
		#expect(ObjectSessionCopy.failedTitle(agentName: nil, reason: nil) == "The agent stopped")
	}

	@Test("origin row hides when nobody resolves")
	func origin() {
		#expect(ObjectSessionCopy.originLine(starterName: "Sam", agentName: "Dev") == "Sam started this")
		#expect(ObjectSessionCopy.originLine(starterName: nil, agentName: "Dev") == "Dev started this")
		#expect(ObjectSessionCopy.originLine(starterName: nil, agentName: nil) == nil)
	}
}

@Suite("ObjectComposerMode")
struct ObjectComposerModeTests {
	private func directory() -> (String?) -> ActorRef? {
		let actors = [
			"a": ActorRef(id: "a", name: "Developer", isAgent: true),
			"h": ActorRef(id: "h", name: "Sam", isAgent: false),
			"b": ActorRef(id: "b", name: "Reviewer", isAgent: true),
		]
		return { $0.flatMap { actors[$0] } }
	}

	private func object(driver: String?, session: ObjectSession? = nil) -> WorkObject {
		var o = WorkObject(id: "o", type: "task", status: "todo", driverId: driver)
		o.lastSession = session
		return o
	}

	@Test("messages the driver when it is an agent")
	func driver() {
		#expect(ObjectComposerMode.target(object: object(driver: "a"), actor: directory())?.name == "Developer")
	}

	@Test("a human driver or none hides the toggle")
	func none() {
		#expect(ObjectComposerMode.target(object: object(driver: "h"), actor: directory()) == nil)
		#expect(ObjectComposerMode.target(object: object(driver: nil), actor: directory()) == nil)
	}

	@Test("the running session's agent wins over the driver")
	func session() {
		let live = ObjectSession(id: "s", status: "running", agentID: "b")
		#expect(ObjectComposerMode.target(object: object(driver: "a", session: live), actor: directory())?.name == "Reviewer")
		let done = ObjectSession(id: "s", status: "completed", agentID: "b")
		#expect(ObjectComposerMode.target(object: object(driver: "a", session: done), actor: directory())?.name == "Developer")
	}

	@Test("message mode names the agent in the placeholder")
	func placeholder() {
		#expect(ObjectComposerMode.message.placeholder(commentPlaceholder: "Comment", agentName: "Dev") == "Message Dev")
		#expect(ObjectComposerMode.comment.placeholder(commentPlaceholder: "Comment", agentName: "Dev") == "Comment")
	}
}

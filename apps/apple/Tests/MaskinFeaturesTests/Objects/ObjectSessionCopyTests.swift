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
		#expect(ObjectSessionCopy.thinkingTitle(agentName: "Developer") == "Developer is thinking")
		#expect(ObjectSessionCopy.thinkingTitle(agentName: nil) == "An agent is thinking")
	}

	@Test("elapsed time reads in seconds, then minutes; nothing before the session starts")
	func elapsed() {
		let start = Date(timeIntervalSince1970: 1_000)
		#expect(ObjectSessionCopy.elapsed(since: start, now: start.addingTimeInterval(12)) == "12s")
		#expect(ObjectSessionCopy.elapsed(since: start, now: start.addingTimeInterval(65)) == "1m 5s")
		#expect(ObjectSessionCopy.elapsed(since: start, now: start.addingTimeInterval(-3)) == "0s")
		#expect(ObjectSessionCopy.elapsed(since: nil, now: start) == nil)
	}

	@Test("the question lead names who asks, as web does")
	func askLead() {
		#expect(ObjectSessionCopy.askLead(askedBy: "Forge") == "Forge asks:")
		#expect(ObjectSessionCopy.askLead(askedBy: nil) == "Open question:")
		#expect(ObjectSessionCopy.askLead(askedBy: "") == "Open question:")
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

	@Test("origin text names the agent, or says an agent")
	func origin() {
		#expect(ObjectSessionCopy.spawnedBy(agentName: "Forge") == "Spawned by Forge")
		#expect(ObjectSessionCopy.spawnedBy(agentName: nil) == "Spawned by an agent")
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

	@Test("the comment box and chip use web's words, shorter on a phone")
	func commentBarCopy() {
		#expect(ObjectComposerMode.commentPlaceholder(compact: false) == "Type / for commands or @ to mention")
		#expect(ObjectComposerMode.commentPlaceholder(compact: true) == "Type / or @")
		#expect(ObjectComposerMode.chipTitle(.comment, agentName: "Dev", compact: false) == "Comment")
		#expect(ObjectComposerMode.chipTitle(.message, agentName: "Dev", compact: false) == "Message Dev")
		#expect(ObjectComposerMode.chipTitle(.message, agentName: "Dev", compact: true) == "Message")
		#expect(ObjectComposerMode.message.placeholder(commentPlaceholder: "c", agentName: "Dev", compact: true) == "Message")
		#expect(ObjectComposerMode.message.placeholder(commentPlaceholder: "c", agentName: "Dev", compact: false) == "Message Dev")
	}
}

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

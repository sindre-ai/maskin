import Foundation
import Testing

@testable import MaskinCore

private func session(workspace: String = "ws-1") -> InMemorySecretStore {
	InMemorySecretStore(
		try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: workspace)))
}

@MainActor
private func makeModel(suggestion: ShareSuggestion?, remote: FakeShareRemote = FakeShareRemote()) -> ShareSheetModel {
	let model = ShareSheetModel(
		secretStore: session(), loadContent: { ShareContent(text: "hello") }, makeRemote: { _ in remote })
	model.suggestion = suggestion
	return model
}

@Suite("ShareSuggestion")
struct ShareSuggestionTests {
	@Test("a suggestion survives the trip through the conversation identifier")
	func roundTrip() {
		let suggestion = ShareSuggestion(workspaceId: "ws-1", agentID: "agent-cpo")
		#expect(ShareSuggestion(conversationIdentifier: suggestion.conversationIdentifier) == suggestion)
	}

	@Test("an identifier that is not ours is not a suggestion")
	func foreign() {
		#expect(ShareSuggestion(conversationIdentifier: nil) == nil)
		#expect(ShareSuggestion(conversationIdentifier: "") == nil)
		#expect(ShareSuggestion(conversationIdentifier: "someone-else:ws-1:agent-cpo") == nil)
		#expect(ShareSuggestion(conversationIdentifier: "maskin.share.agent:ws-1") == nil)
		#expect(ShareSuggestion(conversationIdentifier: "maskin.share.agent::agent-cpo") == nil)
		#expect(ShareSuggestion(conversationIdentifier: "maskin.share.agent:ws-1:a:b") == nil)
	}
}

@Suite("ShareSheetModel suggestion")
@MainActor
struct ShareSheetModelSuggestionTests {
	@Test("tapping an agent in the system sheet starts the chat with that agent")
	func preselects() async {
		let model = makeModel(suggestion: ShareSuggestion(workspaceId: "ws-1", agentID: "agent-researcher"))
		await model.start()
		#expect(model.destination == .newChat(agentID: "agent-researcher"))
		#expect(model.selectedAgent?.name == "Researcher")
		#expect(model.canPost)
	}

	@Test("a suggestion from another workspace is ignored")
	func otherWorkspace() async {
		let model = makeModel(suggestion: ShareSuggestion(workspaceId: "ws-2", agentID: "agent-researcher"))
		await model.start()
		#expect(model.destination == .newChat(agentID: "agent-chief"))
	}

	@Test("an agent that is gone falls back to the usual default")
	func unknownAgent() async {
		let model = makeModel(suggestion: ShareSuggestion(workspaceId: "ws-1", agentID: "agent-deleted"))
		await model.start()
		#expect(model.destination == .newChat(agentID: "agent-chief"))
	}

	@Test("without a suggestion nothing changes")
	func none() async {
		let model = makeModel(suggestion: nil)
		await model.start()
		#expect(model.destination == .newChat(agentID: "agent-chief"))
	}
}

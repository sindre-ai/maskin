import Testing

@testable import MaskinCore

@Suite("SearchResult.kindLabel")
struct SearchKindLabelTests {
	@Test("objects name their own type, flows say Flow")
	func objects() {
		#expect(SearchResult(kind: .object, entityId: "1", title: "t", detail: "bet").kindLabel == "Bet")
		#expect(SearchResult(kind: .object, entityId: "2", title: "t", detail: "loop").kindLabel == "Flow")
		#expect(SearchResult(kind: .object, entityId: "3", title: "t", detail: "pull_request").kindLabel == "Pull Request")
		#expect(SearchResult(kind: .object, entityId: "4", title: "t").kindLabel == "Object")
	}

	@Test("other kinds are named by kind")
	func others() {
		#expect(SearchResult(kind: .chat, entityId: "1", title: "t").kindLabel == "Chat")
		#expect(SearchResult(kind: .agent, entityId: "1", title: "t").kindLabel == "Agent")
		#expect(SearchResult(kind: .file, entityId: "1", title: "t", detail: "application/pdf").kindLabel == "File")
	}
}

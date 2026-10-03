import Testing

@testable import MaskinCore

@Suite("Comment mentions")
struct CommentMentionsTests {
	let relay = ActorRef(id: "a1", name: "Relay", isAgent: true)
	let sam = ActorRef(id: "h1", name: "Sam Lee", isAgent: false)
	let me = ActorRef(id: "me", name: "Me", isAgent: false)

	@Test("candidates match by name, skip yourself and anyone already tagged")
	func candidates() {
		let all = [sam, relay, me]
		#expect(CommentMentions.candidates(query: "", actors: all, selfID: "me", excluding: []).map(\.id) == ["a1", "h1"])
		#expect(CommentMentions.candidates(query: "sam", actors: all, selfID: "me", excluding: []).map(\.id) == ["h1"])
		#expect(CommentMentions.candidates(query: "", actors: all, selfID: "me", excluding: ["a1"]).map(\.id) == ["h1"])
	}

	@Test("picking replaces the @query with the name and a space")
	func inserting() {
		#expect(CommentMentions.inserting(relay, into: "Can you check @re") == "Can you check @Relay ")
		#expect(CommentMentions.inserting(relay, into: "no trigger here") == "no trigger here")
	}

	@Test("a mention whose name was deleted from the text is dropped")
	func active() {
		#expect(CommentMentions.active([relay, sam], in: "ping @Relay please") == ["a1"])
		#expect(CommentMentions.active([relay, relay], in: "@Relay") == ["a1"])
	}
}

import Testing

@testable import MaskinCore

@Suite("Comment references")
struct CommentReferencesTests {
	@Test("a slash starts a reference only at the start of a word, and ends at a space")
	func trigger() {
		#expect(ReferenceTrigger.find(in: "see /mig")?.query == "mig")
		#expect(ReferenceTrigger.find(in: "/")?.query == "")
		#expect(ReferenceTrigger.find(in: "https://x.io/a") == nil)
		#expect(ReferenceTrigger.find(in: "and/or") == nil)
		#expect(ReferenceTrigger.find(in: "see /mig now") == nil)
		#expect(ReferenceTrigger.removingTrigger(from: "see /mig") == "see ")
	}

	@Test("refs are read from a stored comment's metadata")
	func ids() {
		let metadata = JSONValue.object(["refs": .array([.string("a"), .string(""), .string("b")])])
		#expect(ReferenceTrigger.ids(in: metadata) == ["a", "b"])
		#expect(ReferenceTrigger.ids(in: nil).isEmpty)
	}
}

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

	@Test("known @names become mention links, longest name first, code left alone")
	func linked() {
		let senior = ActorRef(id: "a2", name: "Senior", isAgent: true)
		let dev = ActorRef(id: "a3", name: "Senior Developer", isAgent: true)
		let all = [senior, dev, relay]
		#expect(CommentMentions.linked("hi @Senior Developer, ok", actors: all) == "hi [@Senior Developer](mention:a3), ok")
		#expect(CommentMentions.linked("@Senior.", actors: all) == "[@Senior](mention:a2).")
		#expect(CommentMentions.linked("a@Relay and @Seniors", actors: all) == "a@Relay and @Seniors")
		#expect(CommentMentions.linked("`@Relay`", actors: all) == "`@Relay`")
		#expect(CommentMentions.linked("@Nobody", actors: all) == "@Nobody")
	}

	@Test("a mention whose name was deleted from the text is dropped")
	func active() {
		#expect(CommentMentions.active([relay, sam], in: "ping @Relay please") == ["a1"])
		#expect(CommentMentions.active([relay, relay], in: "@Relay") == ["a1"])
	}
}

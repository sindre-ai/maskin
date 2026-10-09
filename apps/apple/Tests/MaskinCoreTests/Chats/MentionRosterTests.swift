import Testing

@testable import MaskinCore

@Suite("MentionRoster")
struct MentionRosterTests {
	private let roster = MentionRoster(people: [
		MentionPerson(id: "seb", name: "Sebastian Krumhausen", kind: .human, roleLabel: "Human · Owner"),
		MentionPerson(id: "ida", name: "Ida Berg", kind: .human, roleLabel: "Human · Member"),
		MentionPerson(id: "cpo", name: "CPO", kind: .agent),
		MentionPerson(id: "dev", name: "Developer", kind: .agent),
		MentionPerson(id: "des", name: "Designer", kind: .agent),
		MentionPerson(id: "dan", name: "Dan Ek", kind: .human),
	])

	@Test("an empty query offers everyone but you, at most five rows")
	func emptyQuery() {
		let found = roster.candidates(query: "", selfID: "seb")
		#expect(found.count == 5)
		#expect(!found.contains { $0.id == "seb" })
	}

	@Test("filters by the start of the full name or the first name, not the middle")
	func prefixOnly() {
		#expect(roster.candidates(query: "ida", selfID: "seb").map(\.id) == ["ida"])
		#expect(roster.candidates(query: "Ida B", selfID: "seb").map(\.id) == ["ida"])
		#expect(roster.candidates(query: "berg", selfID: "seb").isEmpty)
		#expect(roster.candidates(query: "de", selfID: "seb").map(\.id) == ["des", "dev"])
	}

	@Test("people already in the conversation come first")
	func conversationFirst() {
		let found = roster.candidates(query: "d", selfID: "seb", prioritizing: ["dev"])
		#expect(found.first?.id == "dev")
	}

	@Test("builds from members and agents without duplicates, with role labels")
	func fromStores() {
		let members = [
			WorkspaceMember(actorId: "a", name: "Ana Cruz", isAgent: false, role: .owner),
			WorkspaceMember(actorId: "b", name: "Bo Li", isAgent: false, role: .member),
			WorkspaceMember(actorId: "r", name: "Relay", isAgent: true, role: .member),
		]
		let agents = [AgentSummary(id: "r", name: "Relay"), AgentSummary(id: "s", name: "Scout")]
		let built = MentionRoster(members: members, agents: agents)
		#expect(built.people.map(\.id) == ["a", "b", "r", "s"])
		#expect(built.people.map(\.roleLabel) == ["Human · Owner", "Human · Member", "Agent", "Agent"])
	}
}

@Suite("MentionName")
struct MentionNameTests {
	@Test("the token is @ plus the first name")
	func token() {
		#expect(MentionName.token(for: "Ida Berg") == "@Ida")
		#expect(MentionName.token(for: "CPO") == "@CPO")
	}
}

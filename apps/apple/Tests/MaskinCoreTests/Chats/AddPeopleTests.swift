import Testing

@testable import MaskinCore

@Suite struct AddPeopleTests {
	private func actor(
		_ id: String, _ name: String, _ kind: ChatParticipant.Kind = .human, system: Bool = false,
		integration: Bool = false
	) -> ChatActor {
		ChatActor(
			participant: ChatParticipant(id: id, name: name, kind: kind), isSystem: system, isIntegration: integration)
	}

	@Test func listsPeopleAndAgentsTogetherAToZ() {
		let actors = [
			actor("1", "Zoe"), actor("2", "Developer", .agent), actor("3", "anna"), actor("4", "Code Reviewer", .agent),
		]
		let names = AddPeople.candidates(actors, excluding: [], query: "").map(\.participant.name)
		#expect(names == ["anna", "Code Reviewer", "Developer", "Zoe"])
	}

	@Test func neverOffersSystemOrIntegrationAccounts() {
		let actors = [
			actor("1", "Priya"), actor("2", "Chief of Staff", .agent, system: true),
			actor("3", "GitHub", integration: true), actor("4", "Gmail", integration: true),
		]
		#expect(AddPeople.candidates(actors, excluding: [], query: "").map(\.id) == ["1"])
		#expect(AddPeople.candidates(actors, excluding: [], query: "git").isEmpty)
	}

	@Test func leavesOutWhoIsAlreadyInTheChat() {
		let actors = [actor("1", "Priya"), actor("2", "Sam")]
		#expect(AddPeople.candidates(actors, excluding: ["1"], query: "").map(\.id) == ["2"])
	}

	@Test func searchRanksTheBestMatchFirst() {
		let actors = [actor("1", "Anna Berg"), actor("2", "Bergen"), actor("3", "Albert")]
		// A name that starts with the query beats one that has a word starting with it.
		#expect(AddPeople.candidates(actors, excluding: [], query: "berg").map(\.id) == ["2", "1"])
	}

	@Test func buttonTitleFollowsTheCount() {
		#expect(AddPeople.buttonTitle(count: 0) == "Add")
		#expect(AddPeople.buttonTitle(count: 1) == "Add 1 person")
		#expect(AddPeople.buttonTitle(count: 2) == "Add 2 people")
	}

	@Test func toastNamesOnePersonAndCountsSeveral() {
		#expect(AddPeople.addedToast(names: ["Priya"]) == "Priya added")
		#expect(AddPeople.addedToast(names: ["Priya", "Sam"]) == "2 people added")
	}

	@Test func emptyTextTellsSearchFromAnEmptyPool() {
		#expect(AddPeople.emptyText(query: "") == "Everyone in this workspace is already here.")
		#expect(AddPeople.emptyText(query: " x ") == "No one matches “x”. Try a different name.")
	}

	@Test func newChatDoesNotOfferIntegrationAccounts() {
		let actors = [actor("1", "Priya"), actor("2", "Slack", integration: true)]
		let draft = NewConversationDraft()
		#expect(draft.addable(from: actors, excluding: nil).map(\.id) == ["1"])
	}
}

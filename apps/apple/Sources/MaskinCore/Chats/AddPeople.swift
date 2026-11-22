import Foundation

/// What the "Add people" list offers and says. Pure, so the sheet stays thin and the rules are tested.
public enum AddPeople {
	/// Everyone in the workspace who is not already here: people and agents together. Never a system
	/// account (the Chief of Staff, flagged `isSystem`) or an integration account (type "system").
	/// A to Z; while searching, the best match first.
	public static func candidates(_ actors: [ChatActor], excluding: Set<String>, query: String) -> [ChatActor] {
		let offered = actors.filter { !excluding.contains($0.id) && !$0.isSystem && !$0.isIntegration }
			.sorted { $0.participant.name.localizedCaseInsensitiveCompare($1.participant.name) == .orderedAscending }
		return ActorSearch.filter(offered, query: query) { $0.participant.name }
	}

	/// The docked button: "Add" with nothing picked, then "Add 1 person" or "Add N people".
	public static func buttonTitle(count: Int) -> String {
		switch count {
		case ...0: "Add"
		case 1: "Add 1 person"
		default: "Add \(count) people"
		}
	}

	/// The toast after adding: the name for one person, a count for several.
	public static func addedToast(names: [String]) -> String {
		names.count == 1 ? "\(names[0]) added" : "\(names.count) people added"
	}

	/// The line shown when the list is empty: nothing matches the search, or nobody is left to add.
	public static func emptyText(query: String) -> String {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty
			? "Everyone in this workspace is already here." : "No one matches “\(trimmed)”. Try a different name."
	}

	public static let failureText = "Couldn’t add people. Your picks are still selected. Try again."
}

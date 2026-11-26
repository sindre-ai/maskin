import Foundation

/// Where "Create view with agent" was tapped, and so what the view is about.
public enum CreateViewScope: Equatable, Sendable {
	/// The Items list: its type tab (an id such as `contact`) and the filters set on it, as phrases.
	case list(type: String?, filters: [String])
	case object(id: String, title: String, type: String)
	case flow(id: String, name: String)
}

/// The first message of the chat that "Create view with agent" opens, word for word the web one
/// (`apps/web/src/lib/create-view-message.ts`). The person sees it in the message box and can send,
/// edit or clear it: nothing is built until they send.
public enum CreateViewMessage {
	public static let label = "Create view with agent"
	public static let agentName = "Design Studio"
	public static let entryPoint = "create_view"

	private static let howToBuild =
		"Build it as one self-contained HTML file (create_file, mime_type text/html), with an empty and an error state for every number. It can only show names, status, driver and dates."
	private static let pinToFavourites =
		"Then pin it to Favorites in the left nav by adding the file id to the workspace pinned_files setting."

	/// The filters on the Items list as the plain phrases the agent needs, in the web's order and
	/// wording. Empty when none are set.
	public static func listFilters(
		status: String?, search: String, needsYouOnly: Bool, starredOnly: Bool
	) -> [String] {
		var parts: [String] = []
		if let status, !status.isEmpty { parts.append("status \(status)") }
		if !search.isEmpty { parts.append("search \"\(search)\"") }
		if needsYouOnly { parts.append("only the items that need me") }
		if starredOnly { parts.append("only starred items") }
		return parts
	}

	public static func text(for scope: CreateViewScope) -> String {
		switch scope {
		case .flow(let id, let name):
			return [
				"Create a custom view for the flow \"\(name)\" (id \(id)).",
				howToBuild,
				"Then pin it as a tab on this flow with set_loop_view (loop_id \(id)).",
			].joined(separator: "\n\n")
		case .object(let id, let title, let type):
			return [
				"Create a custom view for the \(type) \"\(title)\" (id \(id)).",
				howToBuild,
				pinToFavourites,
			].joined(separator: "\n\n")
		case .list(let type, let filters):
			let filterLine =
				filters.isEmpty
				? "No filters are set on the list."
				: "Filters on the list right now: \(filters.joined(separator: ", "))."
			let subject = type.map { "the \($0) items" } ?? "the items"
			return [
				"Create a custom view of \(subject) in this workspace, like the Items list I am looking at.",
				filterLine,
				howToBuild,
				pinToFavourites,
			].joined(separator: "\n\n")
		}
	}
}

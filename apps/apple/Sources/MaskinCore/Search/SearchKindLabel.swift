import Foundation

extension SearchResult {
	/// The short type label at the end of a result row ("FLOW", "BET", "CHAT"...). Objects name
	/// their own type, flows say FLOW; files have no type worth showing beyond FILE. Never an id.
	public var kindLabel: String {
		switch kind {
		case .chat: return "Chat"
		case .agent: return "Agent"
		case .file: return "File"
		case .object:
			if isFlow { return "Flow" }
			guard let detail, !detail.isEmpty else { return "Object" }
			return detail.replacingOccurrences(of: "_", with: " ").capitalized
		}
	}
}

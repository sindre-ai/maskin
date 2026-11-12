import Foundation

/// The limits and spelling the server enforces on file tags, so the screen refuses what it would
/// refuse. Mirrors `fileTagSchema` in `packages/shared`: trimmed, lowercase, at most 60 characters,
/// no commas (the list filter takes tags comma-separated), at most 20 per file.
public enum FileTagRules {
	public static let maxPerFile = 20
	public static let maxLength = 60

	/// The tag as the server will store it, or nil when it would be refused.
	public static func normalized(_ raw: String) -> String? {
		let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !tag.isEmpty, tag.count <= maxLength, !tag.contains(",") else { return nil }
		return tag
	}

	/// A to Z, the order both apps use for any list of tags a person picks from.
	public static func sorted(_ tags: [String]) -> [String] {
		tags.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}

	public static func sorted(_ counts: [FileTagCount]) -> [FileTagCount] {
		counts.sorted { $0.tag.localizedStandardCompare($1.tag) == .orderedAscending }
	}
}

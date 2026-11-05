import Foundation

/// The decision an agent attached to a comment (`data.decision`): a question and two or three
/// options, the way the web shows it on the timeline.
public struct CommentDecision: Sendable, Equatable {
	public var title: String
	public var summary: String
	public var options: [DecisionOption]

	public static func parse(_ value: JSONValue?) -> CommentDecision? {
		guard case .object(let fields)? = value, case .array(let raw)? = fields["options"] else { return nil }
		let options: [DecisionOption] = raw.compactMap { entry in
			guard let label = entry["label"]?.stringValue, !label.isEmpty else { return nil }
			var consequences: [String] = []
			if case .array(let items)? = entry["consequences"] { consequences = items.compactMap(\.stringValue) }
			var recommended = false
			if case .bool(let b)? = entry["recommended"] { recommended = b }
			var destructive = false
			if case .bool(let b)? = entry["destructive"] { destructive = b }
			return DecisionOption(
				label: label, consequences: consequences, recommended: recommended, destructive: destructive)
		}
		guard options.count >= 2 else { return nil }
		let title = fields["title"]?.stringValue ?? fields["ask"]?.stringValue ?? ""
		return CommentDecision(title: title, summary: fields["summary"]?.stringValue ?? "", options: options)
	}

	/// The option a reply answers with: its text is one of the labels, whoever wrote it.
	public func answer(in replies: [String]) -> String? {
		let labels = Dictionary(options.map { ($0.label.lowercased(), $0.label) }, uniquingKeysWith: { a, _ in a })
		for reply in replies {
			if let label = labels[reply.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()] { return label }
		}
		return nil
	}
}

public enum CommentTasks {
	/// Task object ids in `data.metadata.tasks`, unique, at most 25.
	public static func ids(in data: JSONValue?) -> [String] {
		guard case .array(let raw)? = data?["metadata"]?["tasks"] else { return [] }
		var seen = Set<String>()
		var ids: [String] = []
		for value in raw {
			guard let id = value.stringValue, UUID(uuidString: id) != nil, seen.insert(id).inserted else { continue }
			ids.append(id)
			if ids.count == 25 { break }
		}
		return ids
	}

	public static let doneStatuses: Set<String> = ["done", "completed", "succeeded"]
}

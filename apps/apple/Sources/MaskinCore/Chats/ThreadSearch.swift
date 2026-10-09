import Foundation

/// Finds a query in the messages loaded into a thread, in display order.
public enum ThreadSearch {
	public static func matches(in messages: [ChatMessage], query: String) -> [String] {
		let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !q.isEmpty else { return [] }
		return messages.filter { m in
			(m.kind == "message" || m.kind == "system")
				&& m.content.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
		}.map(\.id)
	}

	/// Steps through `count` matches, wrapping at both ends. nil when there is nothing to step to.
	public static func step(from index: Int?, by delta: Int, count: Int) -> Int? {
		guard count > 0 else { return nil }
		guard let index else { return delta >= 0 ? 0 : count - 1 }
		return ((index + delta) % count + count) % count
	}
}

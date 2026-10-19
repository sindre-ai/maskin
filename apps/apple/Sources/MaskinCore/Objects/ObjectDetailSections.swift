import Foundation

/// One headed block of an object's description: "## Next steps" and the text under it.
public struct ObjectContentSection: Identifiable, Equatable, Sendable {
	public var heading: String
	public var body: String
	public var id: String { heading + "\u{1F}" + body.prefix(24) }

	public init(heading: String, body: String) {
		self.heading = heading
		self.body = body
	}
}

/// Splits an object's markdown description into the text before its first heading (the summary)
/// and its headed sections, and finds the flow an object belongs to.
public enum ObjectDetailLayout {
	/// Headings of level 1 to 3 start a section; `#` lines inside a code fence do not.
	public static func sections(of markdown: String?) -> (lead: String, sections: [ObjectContentSection]) {
		guard let markdown, !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
			return ("", [])
		}
		var lead: [Substring] = []
		var sections: [(heading: String, lines: [Substring])] = []
		var fenced = false
		for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
			if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { fenced.toggle() }
			if !fenced, let heading = heading(in: line) {
				sections.append((heading, []))
			} else if sections.isEmpty {
				lead.append(line)
			} else {
				sections[sections.count - 1].lines.append(line)
			}
		}
		let clean = { (lines: [Substring]) in
			lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
		}
		return (
			clean(lead),
			sections.map { ObjectContentSection(heading: $0.heading, body: clean($0.lines)) }
				.filter { !$0.body.isEmpty }
		)
	}

	private static func heading(in line: Substring) -> String? {
		var hashes = 0
		for char in line {
			guard char == "#" else { break }
			hashes += 1
		}
		guard (1...3).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
		let text = line.dropFirst(hashes).trimmingCharacters(in: .whitespaces)
		return text.isEmpty ? nil : text
	}

	/// The flow (loop) this object sits in: the first linked object of the flow type.
	public static func flow(in links: [ObjectLink]) -> ObjectLink? {
		links.first { $0.otherType == RelatedGrouping.flowType }
	}
}

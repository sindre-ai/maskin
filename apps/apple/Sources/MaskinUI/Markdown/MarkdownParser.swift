import Foundation

/// A block-level markdown node. Inline syntax (bold, italic, code, links) stays as raw
/// markdown text inside blocks and is rendered by `AttributedString(markdown:)`.
public indirect enum MarkdownBlock: Equatable, Hashable, Sendable {
	case heading(level: Int, text: String)
	case paragraph(String)
	case bulletList([[MarkdownBlock]])
	case orderedList(start: Int, items: [[MarkdownBlock]])
	case blockquote([MarkdownBlock])
	case codeBlock(language: String?, code: String)
	/// A GitHub-style pipe table. Every row has exactly `header.count` cells.
	case table(header: [String], alignments: [MarkdownColumnAlignment], rows: [[String]])
	case thematicBreak
}

public enum MarkdownColumnAlignment: Equatable, Hashable, Sendable {
	case leading, center, trailing
}

/// Small CommonMark-subset block parser: ATX headings, paragraphs, bullet / numbered
/// lists (nested), blockquotes, fenced code, pipe tables, thematic breaks. Anything else is a paragraph,
/// so unknown syntax degrades to readable text instead of being dropped.
public enum MarkdownParser {
	/// - Parameter hardBreaks: keep every line break inside a paragraph. CommonMark joins soft
	///   breaks with a space, which suits wrapped prose but collapses what a person typed into
	///   several lines of a chat message.
	public static func parse(_ source: String, hardBreaks: Bool = false) -> [MarkdownBlock] {
		let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
			.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
		return blocks(lines, hardBreaks: hardBreaks)
	}

	// MARK: Line classification

	private static func indent(_ line: String) -> Int {
		var n = 0
		for c in line {
			if c == " " { n += 1 } else if c == "\t" { n += 4 } else { break }
		}
		return n
	}

	private static func isBlank(_ line: String) -> Bool {
		line.allSatisfy { $0 == " " || $0 == "\t" }
	}

	private static func trimmed(_ line: String) -> String {
		line.trimmingCharacters(in: .whitespaces)
	}

	private static func fence(_ line: String) -> (marker: Character, count: Int, info: String)? {
		let t = trimmed(line)
		guard let first = t.first, first == "`" || first == "~" else { return nil }
		let count = t.prefix(while: { $0 == first }).count
		guard count >= 3 else { return nil }
		let info = trimmed(String(t.dropFirst(count)))
		if first == "`", info.contains("`") { return nil }
		return (first, count, info)
	}

	private static func heading(_ line: String) -> (Int, String)? {
		let t = trimmed(line)
		let level = t.prefix(while: { $0 == "#" }).count
		guard (1...6).contains(level) else { return nil }
		let rest = t.dropFirst(level)
		guard rest.isEmpty || rest.first == " " else { return nil }
		var text = trimmed(String(rest))
		// Closing hashes: "## Title ##"
		if text.hasSuffix("#") {
			let stripped = text.reversed().drop(while: { $0 == "#" })
			if stripped.isEmpty || stripped.first == " " {
				text = trimmed(String(stripped.reversed()))
			}
		}
		return (level, text)
	}

	private static func isThematicBreak(_ line: String) -> Bool {
		let t = trimmed(line).filter { $0 != " " }
		guard t.count >= 3, let c = t.first, c == "-" || c == "*" || c == "_" else { return false }
		return t.allSatisfy { $0 == c }
	}

	private struct ListMarker {
		var indent: Int
		var contentIndent: Int
		var ordered: Bool
		var number: Int
		var text: String
	}

	private static func listMarker(_ line: String) -> ListMarker? {
		let lead = indent(line)
		let t = trimmed(line)
		if isThematicBreak(line) { return nil }
		if let c = t.first, "-*+".contains(c), t.count == 1 || t.dropFirst().first == " " {
			let text = trimmed(String(t.dropFirst()))
			return ListMarker(indent: lead, contentIndent: lead + 2, ordered: false, number: 0, text: text)
		}
		let digits = t.prefix(while: \.isNumber)
		if !digits.isEmpty, digits.count <= 9 {
			let after = t.dropFirst(digits.count)
			if let d = after.first, d == "." || d == ")", after.count == 1 || after.dropFirst().first == " " {
				let text = trimmed(String(after.dropFirst()))
				return ListMarker(
					indent: lead, contentIndent: lead + digits.count + 2, ordered: true,
					number: Int(digits) ?? 1, text: text)
			}
		}
		return nil
	}

	// MARK: Tables

	/// Splits a table row into trimmed cells, honouring `\|` escapes and optional outer pipes.
	private static func cells(_ line: String) -> [String] {
		var t = trimmed(line)
		if t.hasPrefix("|") { t.removeFirst() }
		var result: [String] = []
		var current = ""
		var escaped = false
		for c in t {
			if escaped {
				current.append(c == "|" ? "|" : "\\\(c)")
				escaped = false
			} else if c == "\\" {
				escaped = true
			} else if c == "|" {
				result.append(trimmed(current))
				current = ""
			} else {
				current.append(c)
			}
		}
		if escaped { current.append("\\") }
		// A trailing pipe closes the last cell; it does not open an empty one.
		if !trimmed(current).isEmpty || !t.hasSuffix("|") { result.append(trimmed(current)) }
		return result
	}

	/// The column alignments when `line` is a table's delimiter row (`| :-- | :-: | --: |`).
	private static func delimiter(_ line: String) -> [MarkdownColumnAlignment]? {
		guard line.contains("|") else { return nil }
		let parts = cells(line)
		guard !parts.isEmpty else { return nil }
		var alignments: [MarkdownColumnAlignment] = []
		for part in parts {
			let core = part.drop(while: { $0 == ":" }).reversed().drop(while: { $0 == ":" })
			guard !core.isEmpty, core.allSatisfy({ $0 == "-" }) else { return nil }
			switch (part.hasPrefix(":"), part.hasSuffix(":")) {
			case (true, true): alignments.append(.center)
			case (false, true): alignments.append(.trailing)
			default: alignments.append(.leading)
			}
		}
		return alignments
	}

	/// A header row followed by a delimiter row with the same number of columns.
	private static func isTableStart(_ lines: [String], _ i: Int) -> Bool {
		guard i + 1 < lines.count, lines[i].contains("|"), let alignments = delimiter(lines[i + 1]) else {
			return false
		}
		return cells(lines[i]).count == alignments.count
	}

	private static func startsBlock(_ line: String) -> Bool {
		fence(line) != nil || heading(line) != nil || isThematicBreak(line)
			|| trimmed(line).hasPrefix(">") || listMarker(line) != nil
	}

	private static func dedent(_ line: String, by n: Int) -> String {
		var removed = 0
		var idx = line.startIndex
		while idx < line.endIndex, removed < n, line[idx] == " " || line[idx] == "\t" {
			removed += line[idx] == "\t" ? 4 : 1
			idx = line.index(after: idx)
		}
		return String(line[idx...])
	}

	// MARK: Block assembly

	private static func blocks(_ lines: [String], hardBreaks: Bool) -> [MarkdownBlock] {
		var out: [MarkdownBlock] = []
		var i = 0
		while i < lines.count {
			let line = lines[i]
			if isBlank(line) {
				i += 1
				continue
			}

			if let f = fence(line) {
				var code: [String] = []
				let openIndent = indent(line)
				i += 1
				while i < lines.count {
					if let close = fence(lines[i]), close.marker == f.marker, close.count >= f.count, close.info.isEmpty {
						i += 1
						break
					}
					code.append(dedent(lines[i], by: openIndent))
					i += 1
				}
				out.append(.codeBlock(language: f.info.isEmpty ? nil : f.info, code: code.joined(separator: "\n")))
				continue
			}

			if let (level, text) = heading(line) {
				out.append(.heading(level: level, text: text))
				i += 1
				continue
			}

			if isThematicBreak(line) {
				out.append(.thematicBreak)
				i += 1
				continue
			}

			if isTableStart(lines, i), let alignments = delimiter(lines[i + 1]) {
				let header = cells(line)
				var rows: [[String]] = []
				i += 2
				while i < lines.count, !isBlank(lines[i]), lines[i].contains("|"), !startsBlock(lines[i]) {
					var row = Array(cells(lines[i]).prefix(header.count))
					while row.count < header.count { row.append("") }
					rows.append(row)
					i += 1
				}
				out.append(.table(header: header, alignments: alignments, rows: rows))
				continue
			}

			if trimmed(line).hasPrefix(">") {
				var inner: [String] = []
				while i < lines.count, trimmed(lines[i]).hasPrefix(">") {
					var t = trimmed(lines[i]).dropFirst()
					if t.first == " " { t = t.dropFirst() }
					inner.append(String(t))
					i += 1
				}
				out.append(.blockquote(blocks(inner, hardBreaks: hardBreaks)))
				continue
			}

			if let first = listMarker(line) {
				var items: [[MarkdownBlock]] = []
				while i < lines.count, let marker = listMarker(lines[i]),
					marker.ordered == first.ordered, marker.indent < first.contentIndent
				{
					var body = [marker.text]
					i += 1
					// Continuation: indented past the marker, or blank lines followed by such.
					while i < lines.count {
						let next = lines[i]
						if isBlank(next) {
							var j = i
							while j < lines.count, isBlank(lines[j]) { j += 1 }
							if j < lines.count, indent(lines[j]) >= marker.contentIndent {
								body.append(contentsOf: Array(repeating: "", count: j - i))
								i = j
								continue
							}
							break
						}
						if indent(next) >= marker.contentIndent {
							body.append(dedent(next, by: marker.contentIndent))
							i += 1
						} else if listMarker(next) == nil, !startsBlock(next), !isBlank(body.last ?? "") {
							body.append(trimmed(next)) // lazy continuation of the item's paragraph
							i += 1
						} else {
							break
						}
					}
					items.append(blocks(body, hardBreaks: hardBreaks))
					while i < lines.count, isBlank(lines[i]), i + 1 < lines.count, let m = listMarker(lines[i + 1]),
						m.ordered == first.ordered, m.indent < first.contentIndent
					{
						i += 1
					}
				}
				out.append(first.ordered ? .orderedList(start: first.number, items: items) : .bulletList(items))
				continue
			}

			// Paragraph: soft breaks join with a space, hard breaks (two spaces / backslash) keep a newline.
			var para: [String] = []
			while i < lines.count, !isBlank(lines[i]),
				para.isEmpty || (!startsBlock(lines[i]) && !isTableStart(lines, i))
			{
				para.append(lines[i])
				i += 1
			}
			out.append(.paragraph(joinParagraph(para, hardBreaks: hardBreaks)))
		}
		return out
	}

	private static func joinParagraph(_ lines: [String], hardBreaks: Bool) -> String {
		var result = ""
		for (n, raw) in lines.enumerated() {
			let hardBreak = hardBreaks || raw.hasSuffix("  ") || raw.hasSuffix("\\")
			var line = trimmed(raw)
			if raw.hasSuffix("\\") { line = String(line.dropLast()) }
			result += line
			if n < lines.count - 1 { result += hardBreak ? "\n" : " " }
		}
		return result
	}
}

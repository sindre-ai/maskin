import Foundation

/// A formatting action on markdown source, applied to a selection (or a caret when it is empty).
public enum MarkdownFormat: Sendable, CaseIterable {
	case bold, italic, heading, bullet, link
	// Chat formatting (the object editor's toolbar lists its own buttons and does not offer these).
	case strikethrough, code, numbered, quote, codeBlock
}

/// The result of a format: the new text and where the selection should land, as character offsets.
public struct MarkdownEdit: Equatable, Sendable {
	public var text: String
	public var selection: Range<Int>
}

public enum MarkdownFormatting {
	/// Applies `format` to `text` at `selection` (character offsets; empty means a caret).
	/// Inline formats toggle: applying bold to already-bold text removes the markers.
	public static func apply(_ format: MarkdownFormat, to text: String, selection: Range<Int>) -> MarkdownEdit {
		let chars = Array(text)
		let lower = min(max(selection.lowerBound, 0), chars.count)
		let upper = min(max(selection.upperBound, lower), chars.count)
		switch format {
		case .bold: return wrap(chars, lower, upper, marker: "**")
		case .italic: return wrap(chars, lower, upper, marker: "_")
		case .link: return link(chars, lower, upper)
		case .heading: return prefixLines(chars, lower, upper, prefix: "## ")
		case .bullet: return prefixLines(chars, lower, upper, prefix: "- ")
		case .strikethrough: return wrap(chars, lower, upper, marker: "~~")
		case .code: return wrap(chars, lower, upper, marker: "`")
		case .numbered: return prefixLines(chars, lower, upper, prefix: "1. ")
		case .quote: return prefixLines(chars, lower, upper, prefix: "> ")
		case .codeBlock: return codeBlock(chars, lower, upper)
		}
	}

	/// Fences the selection on lines of its own, or removes fences that already surround it. With
	/// nothing selected it opens an empty block and leaves the caret inside.
	private static func codeBlock(_ chars: [Character], _ lower: Int, _ upper: Int) -> MarkdownEdit {
		let open = Array("```\n")
		let close = Array("\n```")
		if lower >= open.count, upper + close.count <= chars.count,
			Array(chars[(lower - open.count)..<lower]) == open, Array(chars[upper..<(upper + close.count)]) == close
		{
			var out = chars
			out.removeSubrange(upper..<(upper + close.count))
			out.removeSubrange((lower - open.count)..<lower)
			return make(out, lower - open.count, upper - open.count)
		}
		var out = chars
		let lead: [Character] = lower > 0 && chars[lower - 1] != "\n" ? ["\n"] : []
		let tail: [Character] = upper < chars.count && chars[upper] != "\n" ? ["\n"] : []
		out.insert(contentsOf: close + tail, at: upper)
		out.insert(contentsOf: lead + open, at: lower)
		let shift = lead.count + open.count
		return make(out, lower + shift, upper + shift)
	}

	private static func make(_ chars: [Character], _ lower: Int, _ upper: Int) -> MarkdownEdit {
		MarkdownEdit(text: String(chars), selection: lower..<upper)
	}

	private static func wrap(_ chars: [Character], _ lower: Int, _ upper: Int, marker: String) -> MarkdownEdit {
		let m = Array(marker)
		let n = m.count
		var out = chars
		// Markers sit just outside the selection: remove them.
		if lower >= n, upper + n <= chars.count,
			Array(chars[(lower - n)..<lower]) == m, Array(chars[upper..<(upper + n)]) == m
		{
			out.removeSubrange(upper..<(upper + n))
			out.removeSubrange((lower - n)..<lower)
			return make(out, lower - n, upper - n)
		}
		// Markers sit just inside the selection: remove them.
		if upper - lower >= 2 * n, Array(chars[lower..<(lower + n)]) == m, Array(chars[(upper - n)..<upper]) == m {
			out.removeSubrange((upper - n)..<upper)
			out.removeSubrange(lower..<(lower + n))
			return make(out, lower, upper - 2 * n)
		}
		out.insert(contentsOf: m, at: upper)
		out.insert(contentsOf: m, at: lower)
		return make(out, lower + n, upper + n)
	}

	private static func link(_ chars: [Character], _ lower: Int, _ upper: Int) -> MarkdownEdit {
		var out = chars
		let label = lower == upper ? Array("text") : Array(chars[lower..<upper])
		let url = Array("url")
		let inserted = ["["] + label.map(String.init) + ["](", "url", ")"]
		out.replaceSubrange(lower..<upper, with: inserted.joined())
		// Select the placeholder URL, ready to be typed over.
		let start = lower + 1 + label.count + 2
		return make(out, start, start + url.count)
	}

	private static func prefixLines(_ chars: [Character], _ lower: Int, _ upper: Int, prefix: String) -> MarkdownEdit {
		let p = Array(prefix)
		func lineStart(_ i: Int) -> Int {
			var j = i
			while j > 0, chars[j - 1] != "\n" { j -= 1 }
			return j
		}
		// A selection ending right after a newline doesn't include the next line.
		let last = upper > lower && chars[upper - 1] == "\n" ? upper - 1 : upper
		var starts: [Int] = [lineStart(lower)]
		var i = starts[0]
		while i < last {
			if chars[i] == "\n", i + 1 <= last, i + 1 < chars.count || i + 1 == last { starts.append(i + 1) }
			i += 1
		}
		starts = starts.filter { $0 <= last }
		let allPrefixed = starts.allSatisfy { s in
			s + p.count <= chars.count && Array(chars[s..<(s + p.count)]) == p
		}
		var out = chars
		var delta = 0
		var firstDelta = 0
		for (index, s) in starts.enumerated() {
			let at = s + delta
			if allPrefixed {
				out.removeSubrange(at..<(at + p.count))
				delta -= p.count
			} else if !(s + p.count <= chars.count && Array(chars[s..<(s + p.count)]) == p) {
				out.insert(contentsOf: p, at: at)
				delta += p.count
			}
			if index == 0 { firstDelta = delta }
		}
		return make(out, max(lower + firstDelta, 0), max(upper + delta, 0))
	}
}

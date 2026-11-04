import Foundation

/// Decodes the HTML entities that show up in story and slide text. One decoder for every
/// reader of agent-authored HTML, so a new entity is fixed once and not in two copies of a loop.
enum HTMLEntities {
	private static let named: [String: String] = [
		"lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
		"middot": "\u{00B7}", "bull": "\u{2022}", "mdash": "\u{2014}", "ndash": "\u{2013}",
		"hellip": "\u{2026}", "lsquo": "\u{2018}", "rsquo": "\u{2019}", "ldquo": "\u{201C}",
		"rdquo": "\u{201D}", "copy": "\u{00A9}", "reg": "\u{00AE}", "trade": "\u{2122}",
		"rarr": "\u{2192}", "larr": "\u{2190}", "times": "\u{00D7}", "deg": "\u{00B0}",
		"amp": "&",
	]

	private static let pattern = try? NSRegularExpression(pattern: "&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);")

	/// Single pass, so `&amp;lt;` becomes `&lt;` and not `<`. Unknown entities are left as written.
	static func decode(_ text: String) -> String {
		guard text.contains("&"), let regex = pattern else { return text }
		let ns = text as NSString
		var out = ""
		var cursor = 0
		for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
			out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
			let body = ns.substring(with: match.range(at: 1))
			out += replacement(for: body) ?? ns.substring(with: match.range)
			cursor = match.range.location + match.range.length
		}
		out += ns.substring(from: cursor)
		return out
	}

	private static func replacement(for body: String) -> String? {
		if body.hasPrefix("#") {
			let digits = body.dropFirst()
			let hex = digits.hasPrefix("x") || digits.hasPrefix("X")
			guard let code = UInt32(hex ? digits.dropFirst() : digits, radix: hex ? 16 : 10),
				let scalar = Unicode.Scalar(code)
			else { return nil }
			return String(Character(scalar))
		}
		return named[body]
	}
}

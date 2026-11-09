import Foundation

/// The page a loop's custom view runs in. Mirrors `prepareBridgedViewHtml` in
/// `apps/web/src/lib/mini-app.ts`: the platform's policy goes in, anything the page brought that
/// could loosen it or send the page elsewhere comes out. The data bridge and the size reporter are
/// not part of the document; the web view adds them as scripts of its own, so the page cannot
/// misplace or remove them.
extension MiniAppHTML {
	private static let dnsPrefetchOffMeta = "<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"
	private static let dnsPrefetchMetaPattern =
		#"<meta\b[^>]*\bhttp-equiv\s*=\s*["']?x-dns-prefetch-control["']?[^>]*>"#

	/// The document the view's web view loads: agent policy and refresh metas removed, DNS prefetch
	/// switched off, then the platform policy placed by a scan that skips scripts, comments and
	/// other text where a `<head>` is not a tag.
	public static func prepareView(_ html: String) -> String {
		var scrubbed = html
		for pattern in [cspMetaPattern, refreshMetaPattern, dnsPrefetchMetaPattern] {
			scrubbed = scrubbed.replacingOccurrences(
				of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
		}
		return injectScanned(dnsPrefetchOffMeta + cspMeta, into: scrubbed)
	}

	// MARK: Placement

	/// Elements whose content is text, not markup: a `<head>` inside one is not the document's head.
	private static let rawTextElements: Set<String> = [
		"script", "style", "textarea", "title", "pre", "code", "template",
	]

	private struct Token {
		enum Kind { case open, doctype }
		var kind: Kind
		var name: String
		var start: Int
		var end: Int
	}

	/// After the real `<head>` open tag, else after the doctype, else before `<body>`, else first.
	static func injectScanned(_ fragment: String, into html: String) -> String {
		let bytes = Array(html.utf8)
		let at: Int
		if let head = firstToken(in: bytes, where: { $0.kind == .open && $0.name == "head" }) {
			at = head.end
		} else if let doctype = firstToken(in: bytes, where: { $0.kind == .doctype }) {
			at = doctype.end
		} else if let body = firstToken(in: bytes, where: { $0.kind == .open && $0.name == "body" }) {
			at = body.start
		} else {
			at = 0
		}
		var out = Array(bytes[..<at])
		out.append(contentsOf: Array(fragment.utf8))
		out.append(contentsOf: bytes[at...])
		return String(decoding: out, as: UTF8.self)
	}

	private static let lt = UInt8(ascii: "<")
	private static let gt = UInt8(ascii: ">")

	private static func isSpace(_ b: UInt8) -> Bool {
		b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0C || b == 0x0D
	}

	private static func isLetter(_ b: UInt8) -> Bool {
		(b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
	}

	private static func isNameByte(_ b: UInt8) -> Bool {
		isLetter(b) || (b >= 0x30 && b <= 0x39) || b == UInt8(ascii: "-")
	}

	private static func hasPrefix(_ bytes: [UInt8], at i: Int, _ text: String, ignoringCase: Bool = false) -> Bool {
		let needle = Array(text.utf8)
		guard i + needle.count <= bytes.count else { return false }
		for (k, n) in needle.enumerated() {
			var b = bytes[i + k]
			if ignoringCase, b >= 0x41, b <= 0x5A { b += 0x20 }
			if b != n { return false }
		}
		return true
	}

	private static func find(_ bytes: [UInt8], _ text: String, from: Int) -> Int? {
		let needle = Array(text.utf8)
		guard !needle.isEmpty, bytes.count >= needle.count, from <= bytes.count - needle.count else { return nil }
		var i = from
		while i <= bytes.count - needle.count {
			if bytes[i] == needle[0], hasPrefix(bytes, at: i, text) { return i }
			i += 1
		}
		return nil
	}

	/// The index just past the `>` that closes the tag starting at `start`. A `>` inside a quoted
	/// attribute value is part of the value.
	private static func tagEnd(_ bytes: [UInt8], _ start: Int) -> Int? {
		var i = start + 1
		var quote: UInt8?
		while i < bytes.count {
			let b = bytes[i]
			if let q = quote {
				if b == q { quote = nil }
			} else if b == UInt8(ascii: "\"") || b == UInt8(ascii: "'") {
				quote = b
			} else if b == gt {
				return i + 1
			}
			i += 1
		}
		return nil
	}

	/// The index just past the close tag of a raw-text element, searching from `from`.
	private static func closeTagEnd(_ bytes: [UInt8], name: String, from: Int) -> Int? {
		var i = from
		while let at = find(bytes, "</", from: i) {
			if hasPrefix(bytes, at: at + 2, name, ignoringCase: true) {
				var j = at + 2 + name.utf8.count
				while j < bytes.count, isSpace(bytes[j]) { j += 1 }
				if j < bytes.count, bytes[j] == gt { return j + 1 }
			}
			i = at + 2
		}
		return nil
	}

	private static func firstToken(in bytes: [UInt8], where matches: (Token) -> Bool) -> Token? {
		var i = 0
		while i < bytes.count {
			guard let at = bytes[i...].firstIndex(of: lt) else { return nil }
			if hasPrefix(bytes, at: at, "<!--") {
				guard let close = find(bytes, "-->", from: at + 4) else { return nil }
				i = close + 3
				continue
			}
			if hasPrefix(bytes, at: at, "<![CDATA[") {
				guard let close = find(bytes, "]]>", from: at + 9) else { return nil }
				i = close + 3
				continue
			}
			if at + 1 < bytes.count, isLetter(bytes[at + 1]) {
				var j = at + 1
				while j < bytes.count, isNameByte(bytes[j]) { j += 1 }
				if j < bytes.count, isSpace(bytes[j]) || bytes[j] == gt || bytes[j] == UInt8(ascii: "/") {
					let name = String(decoding: bytes[(at + 1)..<j], as: UTF8.self).lowercased()
					guard let end = tagEnd(bytes, at) else { return nil }
					if rawTextElements.contains(name) {
						guard let after = closeTagEnd(bytes, name: name, from: end) else { return nil }
						i = after
						continue
					}
					let token = Token(kind: .open, name: name, start: at, end: end)
					if matches(token) { return token }
					i = end
					continue
				}
			}
			if hasPrefix(bytes, at: at, "<!doctype", ignoringCase: true) {
				let next = at + 9
				if next < bytes.count, isSpace(bytes[next]) || bytes[next] == gt {
					guard let end = tagEnd(bytes, at) else { return nil }
					let token = Token(kind: .doctype, name: "!doctype", start: at, end: end)
					if matches(token) { return token }
					i = end
					continue
				}
			}
			i = at + 1
		}
		return nil
	}
}

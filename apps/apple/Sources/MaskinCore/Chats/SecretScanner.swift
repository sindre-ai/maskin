import Foundation

/// Catches a pasted secret before it is sent. A port of the high-confidence rows of
/// `packages/shared/src/secret-scanner.ts`, which the server backstop (`refuseRawSecret`) applies
/// too: a message that holds one is refused with `RAW_SECRET_DETECTED`, so without this a pasted key
/// would only come back as a failed send with no way to vault it. The server stays the authority
/// (the web can also override a regex remotely); this table is a courtesy that must list the same
/// rows. `SecretScannerTests` compares it with the TypeScript file so the two cannot drift quietly.
public enum SecretScanner {
	public struct Pattern: Equatable, Sendable {
		public var id: String
		public var source: String
		/// Card copy, for example "a Cloudflare API token".
		public var description: String

		/// A short name to pre-fill when saving it, matching the web ("API key" for a bare service secret).
		public var label: String {
			["cloudflare": "Cloudflare", "github": "GitHub", "stripe": "Stripe", "slack": "Slack"][id] ?? "API key"
		}
	}

	public struct Match: Equatable, Sendable {
		public var patternID: String
		/// A name to offer for the credential.
		public var suggestedName: String {
			SecretScanner.highConfidence.first { $0.id == patternID }?.label ?? "API key"
		}
		public var description: String
		public var range: Range<String.Index>
		public var value: String
	}

	/// The five high-confidence rows, in the server's order (on equal length the earlier row wins).
	public static let highConfidence: [Pattern] = [
		Pattern(id: "stripe", source: #"\bsk_(?:live|test)_[A-Za-z0-9]{24,}"#, description: "a Stripe secret key"),
		Pattern(
			id: "cloudflare", source: #"\b(?:cfut|cfat|cfk)_[A-Za-z0-9]{40,64}\b"#, description: "a Cloudflare API token"),
		Pattern(
			id: "github", source: #"\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b"#,
			description: "a GitHub personal access token"),
		Pattern(id: "slack", source: #"\bxox[bp]-[A-Za-z0-9-]{20,}"#, description: "a Slack token"),
		Pattern(
			id: "openai-style", source: #"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}"#,
			description: "an API key with a service-secret prefix"),
	]

	/// Non-overlapping matches in text order. Longest wins, then table order.
	public static func scan(_ text: String) -> [Match] {
		struct Candidate {
			var match: Match
			var order: Int
		}
		var candidates: [Candidate] = []
		let whole = NSRange(text.startIndex..., in: text)
		for (order, pattern) in highConfidence.enumerated() {
			guard let regex = try? NSRegularExpression(pattern: pattern.source) else { continue }
			for found in regex.matches(in: text, range: whole) {
				guard let range = Range(found.range, in: text) else { continue }
				candidates.append(
					Candidate(
						match: Match(
							patternID: pattern.id, description: pattern.description, range: range, value: String(text[range])),
						order: order))
			}
		}
		candidates.sort {
			let a = $0.match.value.count, b = $1.match.value.count
			return a != b ? a > b : $0.order < $1.order
		}
		var taken: [Match] = []
		for candidate in candidates
		where !taken.contains(where: { $0.range.overlaps(candidate.match.range) }) {
			taken.append(candidate.match)
		}
		return taken.sorted { $0.range.lowerBound < $1.range.lowerBound }
	}

	public static func firstSecret(in text: String) -> Match? { scan(text).first }

	/// The text with every matched secret cut out and nothing put in its place: their own words are
	/// kept, the secret is not. A space on each side of a cut collapses to one, and spaces left at
	/// either end go. Line breaks are never touched.
	public static func withoutSecrets(_ text: String, _ matches: [Match]) -> String {
		var out = ""
		var cursor = text.startIndex
		for match in matches.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
			out += text[cursor..<match.range.lowerBound]
			cursor = match.range.upperBound
			if out.hasSuffix(" "), cursor < text.endIndex, text[cursor] == " " { cursor = text.index(after: cursor) }
		}
		out += text[cursor...]
		return out.trimmingCharacters(in: CharacterSet(charactersIn: " "))
	}

	/// For example `cfut_[REDACTED · vaulted as NAME]`: the provider's prefix is kept, the value is not.
	public static func redactionMarker(for secret: String, name: String) -> String {
		let prefix =
			secret.range(
				of: #"^(?:(?:cfut|cfat|cfk|ghp|github_pat|sk_live|sk_test)_|xox[bp]-|sk-(?:proj-|svcacct-)?)"#,
				options: .regularExpression
			).map { String(secret[$0]) } ?? ""
		return "\(prefix)[REDACTED · vaulted as \(name)]"
	}

	/// The text with each matched secret replaced by its marker, so the agent can see where a key was.
	public static func redacted(_ text: String, _ matches: [Match], name: String) -> String {
		var out = ""
		var cursor = text.startIndex
		for match in matches.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
			out += text[cursor..<match.range.lowerBound] + redactionMarker(for: match.value, name: name)
			cursor = match.range.upperBound
		}
		return out + text[cursor...]
	}

	/// What the person sees for a secret: first and last characters only, never the whole value.
	public static func masked(_ value: String) -> String {
		let head =
			value.range(of: #"^[A-Za-z]+[_-]"#, options: .regularExpression).map { String(value[$0]) }
			?? String(value.prefix(3))
		return "\(head)…\(value.suffix(4))"
	}
}

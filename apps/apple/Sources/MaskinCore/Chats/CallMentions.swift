import Foundation

/// An object a message in the conversation points at.
public struct MentionedObject: Equatable, Hashable, Sendable, Identifiable {
	public let id: String
	public let title: String
	public let workspaceId: String
}

/// The objects a call's conversation has mentioned, for "Pull up": agents answer with markdown links
/// to the things they mean (`[Fix the quota guard](https://maskin.io/<ws>/objects/<id>)`), and those are
/// what the person wants to look at next, so they come first, newest message first.
public enum CallMentions {
	/// Objects linked in `messages`, newest message first, each once. A link's text is its title; a bare
	/// URL falls back to "Object".
	public static func objects(in messages: [ChatMessage], limit: Int = 20) -> [MentionedObject] {
		var order: [String] = []
		var byID: [String: MentionedObject] = [:]
		for message in messages.reversed() where message.kind == "message" {
			for item in links(in: message.content) {
				guard case .object(let workspace, let id)? = DeepLink(string: item.url) else { continue }
				let mention = MentionedObject(id: id, title: item.title, workspaceId: workspace)
				if let held = byID[id] {
					// The same object linked again: keep the more descriptive text ("again" says nothing).
					if mention.title.count > held.title.count, held.title == "Object" || mention.title != "Object" {
						byID[id] = mention
					}
				} else {
					byID[id] = mention
					order.append(id)
				}
			}
		}
		return order.prefix(limit).compactMap { byID[$0] }
	}

	private static let markdownLink = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\((https?://[^)\s]+)\)"#)
	private static let bareURL = try! NSRegularExpression(pattern: #"https?://[^\s)\]>]+"#)

	struct Link: Sendable, Equatable {
		var title: String
		var url: String
	}

	/// Both patterns need an `http`; most messages have none, so they skip the regex passes. The
	/// rest are remembered by text: a call card reads these links on every render of the thread.
	private static func links(in text: String) -> [(title: String, url: String)] {
		links(in: text, cache: LinkScanCaches.callLinks).map { ($0.title, $0.url) }
	}

	static func links(in text: String, cache: LinkScanCache<[Link]>) -> [Link] {
		guard text.contains("http") else { return [] }
		return cache.value(for: text) { scanLinks(in: text).map { Link(title: $0.title, url: $0.url) } }
	}

	private static func scanLinks(in text: String) -> [(title: String, url: String)] {
		let whole = NSRange(text.startIndex..., in: text)
		var out: [(Int, String, String)] = []
		var covered: [NSRange] = []
		for match in markdownLink.matches(in: text, range: whole) {
			guard let title = Range(match.range(at: 1), in: text), let url = Range(match.range(at: 2), in: text) else { continue }
			out.append((match.range.location, String(text[title]), String(text[url])))
			covered.append(match.range)
		}
		for match in bareURL.matches(in: text, range: whole)
		where !covered.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) {
			guard let url = Range(match.range, in: text) else { continue }
			out.append((match.range.location, "Object", String(text[url])))
		}
		return out.sorted { $0.0 < $1.0 }.map { ($0.1, $0.2) }
	}
}

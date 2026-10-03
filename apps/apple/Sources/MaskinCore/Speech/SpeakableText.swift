import Foundation

/// Turns an agent's markdown reply into text worth reading aloud: no markup characters, no code
/// dumps, no raw URLs, no table scaffolding.
public enum SpeakableText {
	public static func from(markdown: String) -> String {
		var out: [String] = []
		var inFence = false
		var skippedCode = false
		for raw in markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
			let trimmed = raw.trimmingCharacters(in: .whitespaces)
			if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
				inFence.toggle()
				if inFence, !skippedCode {
					out.append("Code block skipped.")
					skippedCode = true
				}
				continue
			}
			if inFence { continue }
			guard let line = cleanLine(trimmed) else { continue }
			out.append(line)
		}
		return out.joined(separator: "\n")
			.replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
			.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// nil drops the line (rules, table separators).
	private static func cleanLine(_ line: String) -> String? {
		if line.isEmpty { return "" }
		if line.range(of: "^([-*_]\\s*){3,}$", options: .regularExpression) != nil { return nil }
		if line.range(of: "^\\|?[\\s:|-]+\\|?$", options: .regularExpression) != nil, line.contains("-") {
			return nil
		}
		var s = line
		s = s.replacingOccurrences(of: "^#{1,6}\\s+", with: "", options: .regularExpression)
		s = s.replacingOccurrences(of: "^>+\\s?", with: "", options: .regularExpression)
		s = s.replacingOccurrences(of: "^[-*+]\\s+\\[[ xX]\\]\\s+", with: "", options: .regularExpression)
		s = s.replacingOccurrences(of: "^[-*+]\\s+", with: "", options: .regularExpression)
		s = s.replacingOccurrences(of: "^\\d+[.)]\\s+", with: "", options: .regularExpression)
		// Images: drop; links: keep the label.
		s = s.replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: "", options: .regularExpression)
		s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
		s = s.replacingOccurrences(of: "https?://\\S+", with: "link", options: .regularExpression)
		// Table rows read as comma-separated cells.
		if s.hasPrefix("|") || s.hasSuffix("|") {
			s = s.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
				.filter { !$0.isEmpty }.joined(separator: ", ")
		}
		// Emphasis, strikethrough, inline code.
		s = s.replacingOccurrences(of: "(\\*\\*|__|~~)(.+?)\\1", with: "$2", options: .regularExpression)
		s = s.replacingOccurrences(of: "(?<![\\w*])[*_](\\S(?:.*?\\S)?)[*_](?![\\w*])", with: "$1", options: .regularExpression)
		s = s.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
		s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
		return s.trimmingCharacters(in: .whitespaces)
	}
}

/// Whether a new message in the open thread should be read aloud in hands-free mode.
public enum SpeechPolicy {
	/// Only fresh replies from someone else (an agent or a person), never your own message, a
	/// system line, a pending row, or backlog that arrives after a reconnect.
	public static func shouldAutoSpeak(
		_ message: ChatMessage, currentActorID: String?, now: Date = Date(), freshness: TimeInterval = 120
	) -> Bool {
		guard message.kind == "message", message.author == .agent, message.actorID != currentActorID,
			message.serverID != nil, !message.content.isEmpty
		else { return false }
		guard let created = message.createdAt else { return true }
		return now.timeIntervalSince(created) <= freshness
	}
}

/// Decides which messages hands-free mode reads. Messages already in the thread when it opened
/// (history) are marked seen by `prime(with:)` and never spoken; every message that ARRIVES after
/// that and passes `SpeechPolicy` is returned once, in order, so a burst of replies is read in
/// full rather than just the last one.
public struct HandsFreeTracker: Sendable {
	private var seen: Set<String> = []
	public private(set) var isPrimed = false

	public init() {}

	public mutating func prime(with messages: [ChatMessage]) {
		seen = Set(messages.map(\.id))
		isPrimed = true
	}

	/// Always call as messages change, even with hands-free off, so turning it on later does not
	/// read what arrived in the meantime.
	public mutating func newReplies(
		in messages: [ChatMessage], currentActorID: String?, now: Date = Date()
	) -> [ChatMessage] {
		guard isPrimed else { return [] }
		var fresh: [ChatMessage] = []
		for message in messages where seen.insert(message.id).inserted {
			if SpeechPolicy.shouldAutoSpeak(message, currentActorID: currentActorID, now: now) {
				fresh.append(message)
			}
		}
		return fresh
	}
}

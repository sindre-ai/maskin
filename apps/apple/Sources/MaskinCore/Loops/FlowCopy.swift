import Foundation

/// The Flows list subtitle: "Three outcomes in motion. Two need you." Counts up to twelve are
/// spelled out like the handoff copy; larger ones stay digits.
public enum FlowsSummary {
	private static let words = [
		"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
		"eleven", "twelve",
	]

	static func count(_ n: Int) -> String {
		words.indices.contains(n) ? words[n] : "\(n)"
	}

	private static func capitalised(_ text: String) -> String {
		text.prefix(1).uppercased() + text.dropFirst()
	}

	/// Nil when nothing is running. `needYou` is the share of the running flows that wait on the
	/// viewer, so it never reads larger than `running`.
	public static func line(running: Int, needYou: Int) -> String? {
		guard running > 0 else { return nil }
		let moving = "\(capitalised(count(running))) \(running == 1 ? "outcome" : "outcomes") in motion."
		let needs = min(needYou, running)
		guard needs > 0 else { return moving }
		return moving + " \(capitalised(count(needs))) \(needs == 1 ? "needs" : "need") you."
	}
}

/// The flow card's LATEST UPDATE: the newest thing an agent posted, cut to one sentence.
public enum LoopLatestUpdate {
	/// The author is shown in bold ahead of the sentence; nil when the name did not resolve.
	public struct Line: Equatable, Sendable {
		public var author: String?
		public var text: String

		public init(author: String?, text: String) {
			self.author = author
			self.text = text
		}
	}

	/// About how long the sentence runs on the card.
	public static let limit = 130

	/// Markdown the agent wrote, flattened to plain running text.
	static func plain(_ markdown: String) -> String {
		var text = markdown
		// [label](url) -> label
		text = text.replacingOccurrences(
			of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
		// Leading heading, quote and list markers on each line.
		text = text.replacingOccurrences(
			of: #"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+"#, with: "", options: .regularExpression)
		for mark in ["**", "__", "`", "~~"] { text = text.replacingOccurrences(of: mark, with: "") }
		return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}

	/// Whole sentences from the start of `text` while they fit in `limit`; a first sentence that is
	/// itself too long is cut at a word with an ellipsis.
	public static func sentence(from markdown: String, limit: Int = LoopLatestUpdate.limit) -> String {
		let text = plain(markdown)
		guard text.count > limit else { return text }
		var sentences: [String] = []
		var current = ""
		let characters = Array(text)
		for (i, ch) in characters.enumerated() {
			current.append(ch)
			let ends = ch == "." || ch == "!" || ch == "?"
			let next = i + 1 < characters.count ? characters[i + 1] : " "
			if ends && next == " " {
				sentences.append(current.trimmingCharacters(in: .whitespaces))
				current = ""
			}
		}
		if !current.trimmingCharacters(in: .whitespaces).isEmpty {
			sentences.append(current.trimmingCharacters(in: .whitespaces))
		}
		var kept = ""
		for sentence in sentences {
			let candidate = kept.isEmpty ? sentence : kept + " " + sentence
			if candidate.count > limit { break }
			kept = candidate
		}
		if !kept.isEmpty { return kept }
		let head = String(text.prefix(limit))
		let cut = head.lastIndex(of: " ").map { String(head[..<$0]) } ?? head
		return cut.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:.-")) + "…"
	}

	public static func line(post: LoopPost, author: String?) -> Line? {
		let text = sentence(from: post.text)
		guard !text.isEmpty else { return nil }
		return Line(author: author, text: text)
	}
}

/// Something stuck on a flow, derived only from a session that failed or timed out and has not
/// been followed by a run since.
public struct FlowProblem: Equatable, Sendable {
	public enum Kind: Sendable, Equatable { case failed, timedOut }

	public var kind: Kind
	public var entryID: String
	public var actorID: String?
	/// What the server said about the run, when it said anything.
	public var detail: String?
	public var date: Date?

	/// Mono label on the banner.
	public var label: String { kind == .failed ? "Run failed" : "Run timed out" }
}

public enum FlowProblems {
	/// A failure older than this is history, not a flow that is stuck now.
	public static let window: TimeInterval = 7 * 24 * 3600

	/// The newest run outcome decides: failed or timed out is a problem, a run that started or
	/// finished after it clears the problem. A draft or paused flow is not stuck, it is stopped.
	public static func derive(
		loop: LoopSummary, activity: [LoopActivityEntry], now: Date
	) -> FlowProblem? {
		guard loop.status.isLive else { return nil }
		let sessions = activity.enumerated()
			.filter { $0.element.action.hasPrefix("session_") }
			.sorted {
				let a = $0.element.createdAt ?? .distantPast, b = $1.element.createdAt ?? .distantPast
				return a != b ? a > b : $0.offset < $1.offset
			}
			.map(\.element)
		guard let latest = sessions.first, latest.tone == .failure else { return nil }
		if let date = latest.createdAt, now.timeIntervalSince(date) > window { return nil }
		let description = latest.description?.trimmingCharacters(in: .whitespacesAndNewlines)
		return FlowProblem(
			kind: latest.action == "session_timeout" ? .timedOut : .failed, entryID: latest.id,
			actorID: latest.actorID, detail: (description?.isEmpty ?? true) ? nil : description,
			date: latest.createdAt)
	}
}

/// One day of the "Last 7 days" strip.
public struct LoopRunDay: Equatable, Sendable, Identifiable {
	public var day: Date
	public var runs: Int
	public var failures: Int
	public var isToday: Bool
	public var id: Date { day }
}

public enum LoopRunHistory {
	/// How many events the activity endpoint returns; a full feed may not reach back seven days.
	public static let feedLimit = 50

	/// Seven days ending today, oldest first, from the activity feed. A run is a session that
	/// started; a day where only the finish is in the feed still counts the sessions it finished.
	public static func days(
		from activity: [LoopActivityEntry], now: Date, calendar: Calendar = .current, count: Int = 7
	) -> [LoopRunDay] {
		let today = calendar.startOfDay(for: now)
		let starts = (0..<count).reversed().compactMap { calendar.date(byAdding: .day, value: -$0, to: today) }
		return starts.map { start in
			let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
			let day = activity.filter { entry in
				guard let date = entry.createdAt else { return false }
				return date >= start && date < end
			}
			let created = day.filter { $0.action == "session_created" }.count
			let failed = day.filter { $0.action == "session_failed" || $0.action == "session_timeout" }.count
			let finished = failed + day.filter { $0.action == "session_completed" }.count
			return LoopRunDay(
				day: start, runs: max(created, finished), failures: failed, isToday: start == today)
		}
	}

	/// True when the feed is full and its oldest entry is still inside the window, so older days
	/// of the strip may be undercounted.
	public static func mayBeTruncated(
		_ activity: [LoopActivityEntry], now: Date, calendar: Calendar = .current, count: Int = 7
	) -> Bool {
		guard activity.count >= feedLimit,
			let oldest = activity.compactMap(\.createdAt).min(),
			let first = calendar.date(
				byAdding: .day, value: -(count - 1), to: calendar.startOfDay(for: now))
		else { return false }
		return oldest > first
	}

	/// "12 runs, 1 failed" / "No runs".
	public static func summary(_ days: [LoopRunDay]) -> String {
		let runs = days.reduce(0) { $0 + $1.runs }
		let failed = days.reduce(0) { $0 + $1.failures }
		guard runs > 0 else { return "No runs" }
		let base = "\(runs) \(runs == 1 ? "run" : "runs")"
		return failed > 0 ? base + ", \(failed) failed" : base
	}
}

import Foundation

/// One run of a flow: a session launched from one of its triggers. Read from the sessions list,
/// which the activity feed (events only) cannot give: which trigger ran, and for how long.
public struct LoopRun: Identifiable, Equatable, Sendable {
	public var id: String
	public var triggerID: String?
	public var status: String
	public var createdAt: Date?
	public var startedAt: Date?
	public var completedAt: Date?

	public init(
		id: String, triggerID: String? = nil, status: String, createdAt: Date? = nil,
		startedAt: Date? = nil, completedAt: Date? = nil
	) {
		self.id = id
		self.triggerID = triggerID
		self.status = status
		self.createdAt = createdAt
		self.startedAt = startedAt
		self.completedAt = completedAt
	}

	public var isFailure: Bool { status == "failed" || status == "timeout" }

	/// How long a run that finished took; nil for one still going or one that did not finish.
	public var duration: TimeInterval? {
		guard status == "completed", let startedAt, let completedAt, completedAt >= startedAt else {
			return nil
		}
		return completedAt.timeIntervalSince(startedAt)
	}
}

/// Why a flow is flagged "stuck", and the one thing the banner says about it.
public struct FlowProblem: Equatable, Sendable {
	public enum Kind: Sendable, Equatable {
		/// The newest run failed or timed out and nothing has started since. `step` is its 1-based
		/// position in the flow when the run can be matched to a step.
		case stepFailed(step: Int?, timedOut: Bool)
		/// A flow with work in flight has made no progress for `idleFor`.
		case stalled(idleFor: TimeInterval)
		/// A decision has been waiting on the viewer for `days` whole days (more than 48 hours).
		case waitingOnYou(days: Int)
	}

	public var kind: Kind
	public var entryID: String?
	public var actorID: String?
	/// What the server said about the run, when it said anything.
	public var detail: String?
	public var date: Date?

	public init(
		kind: Kind, entryID: String? = nil, actorID: String? = nil, detail: String? = nil,
		date: Date? = nil
	) {
		self.kind = kind
		self.entryID = entryID
		self.actorID = actorID
		self.detail = detail
		self.date = date
	}

	/// Mono label on the banner.
	public var label: String {
		switch kind {
		case .stepFailed(_, let timedOut): timedOut ? "Run timed out" : "Run failed"
		case .stalled: "Stalled"
		case .waitingOnYou: "Waiting on you"
		}
	}

	/// The banner sentence, from the copy deck. No "Retry": nothing in the app reruns a step.
	public var headline: String {
		switch kind {
		case .stepFailed(let step, _):
			step.map { "Step \($0) failed." } ?? "A step failed."
		case .stalled(let idle):
			"Nothing has moved for \(LoopDurationFormat.string(idle))."
		case .waitingOnYou(let days):
			"Waiting on you for \(days) days."
		}
	}

	/// What the Ask Chief of Staff pill hands to chat.
	public func question(flow: String) -> String {
		switch kind {
		case .stepFailed(let step, let timedOut):
			let which = step.map { "step \($0)" } ?? "a step"
			return "The flow \(flow) is stuck: \(which) \(timedOut ? "timed out" : "failed"). What happened, and what should we do? "
		case .stalled(let idle):
			return "The flow \(flow) hasn't moved for \(LoopDurationFormat.string(idle)). What is it waiting on? "
		case .waitingOnYou(let days):
			return "The flow \(flow) has been waiting on me for \(days) days. What is it asking, and what do you suggest? "
		}
	}
}

/// "3h 20m", "2d 4h": a duration as the stuck banner and the flow page write it.
public enum LoopDurationFormat {
	public static func string(_ seconds: TimeInterval) -> String {
		let formatter = DateComponentsFormatter()
		formatter.unitsStyle = .abbreviated
		formatter.maximumUnitCount = 2
		formatter.allowedUnits = [.day, .hour, .minute]
		return formatter.string(from: max(seconds, 60)) ?? "—"
	}
}

public enum FlowProblems {
	/// A failure older than this is history, not a flow that is stuck now.
	public static let window: TimeInterval = 7 * 24 * 3600
	/// A decision waiting longer than this is a problem.
	public static let waitingLimit: TimeInterval = 48 * 3600
	/// The smallest idle time that counts as stalled, however fast the steps usually are.
	public static let stallFloor: TimeInterval = 30 * 60
	/// A stall is idle time past this many median step times.
	public static let stallMultiple = 2.0
	/// Finished runs needed before a median step time means anything.
	public static let minSamples = 3

	/// The most urgent thing wrong with a flow, or nil. A paused or draft flow is stopped, not
	/// stuck. Order: a failed step, then a decision waiting too long (which also explains why
	/// nothing moves), then a stall.
	///
	/// Derived only from what the app already loads. "Retries exhausted" is read as: the newest run
	/// failed and no run has started since, because the data carries no retry counter.
	public static func derive(
		loop: LoopSummary, steps: [LoopStep] = [], activity: [LoopActivityEntry] = [],
		runs: [LoopRun] = [], posts: [LoopPost] = [], now: Date
	) -> FlowProblem? {
		guard loop.status.isLive else { return nil }
		return failedStep(steps: steps, activity: activity, runs: runs, now: now)
			?? waitingTooLong(loop: loop, posts: posts, now: now)
			?? stalled(loop: loop, steps: steps, activity: activity, runs: runs, now: now)
	}

	/// The newest run outcome decides: failed or timed out is a problem, a run that started or
	/// finished after it clears the problem.
	static func failedStep(
		steps: [LoopStep], activity: [LoopActivityEntry], runs: [LoopRun], now: Date
	) -> FlowProblem? {
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
		let triggerID = runs.first { $0.id == latest.entityID }?.triggerID
		let step = triggerID.flatMap { id in steps.firstIndex { $0.triggerID == id } }.map { $0 + 1 }
		return FlowProblem(
			kind: .stepFailed(step: step, timedOut: latest.action == "session_timeout"),
			entryID: latest.id, actorID: latest.actorID,
			detail: (description?.isEmpty ?? true) ? nil : description, date: latest.createdAt)
	}

	/// The oldest of the decisions still open (the newest `waitingCount` decision posts) has been
	/// open for more than 48 hours.
	static func waitingTooLong(loop: LoopSummary, posts: [LoopPost], now: Date) -> FlowProblem? {
		guard loop.waitingCount > 0 else { return nil }
		let open = posts.filter(\.isDecision)
			.compactMap { post in post.date.map { (post, $0) } }
			.sorted { $0.1 > $1.1 }
			.prefix(loop.waitingCount)
		guard let oldest = open.last else { return nil }
		let waited = now.timeIntervalSince(oldest.1)
		guard waited > waitingLimit else { return nil }
		return FlowProblem(
			kind: .waitingOnYou(days: Int(waited / 86400)), actorID: oldest.0.actorID, date: oldest.1)
	}

	/// Work is in flight, nobody is waiting on the viewer, and nothing has started or finished for
	/// more than twice the median step time (never under 30 minutes).
	///
	/// Silent when it can't tell: fewer than three finished runs to take a median from, or a step on
	/// a schedule that has not fired yet (a flow that sleeps between ticks is idle by design).
	static func stalled(
		loop: LoopSummary, steps: [LoopStep], activity: [LoopActivityEntry], runs: [LoopRun], now: Date
	) -> FlowProblem? {
		guard loop.inProgressCount > 0, loop.waitingCount == 0 else { return nil }
		if steps.contains(where: { LoopComingUp.nextRun(of: $0, after: now) != nil }) { return nil }
		let durations = runs.compactMap(\.duration).filter { $0 > 0 }
		guard durations.count >= minSamples, let median = median(durations) else { return nil }
		let moved = runs.flatMap { [$0.createdAt, $0.startedAt, $0.completedAt] }.compactMap { $0 }
			+ activity.filter { ["session_created", "session_running", "session_completed"].contains($0.action) }
			.compactMap(\.createdAt)
		guard let last = moved.max() else { return nil }
		let idle = now.timeIntervalSince(last)
		guard idle > max(median * stallMultiple, stallFloor) else { return nil }
		return FlowProblem(kind: .stalled(idleFor: idle), date: last)
	}

	static func median(_ values: [TimeInterval]) -> TimeInterval? {
		guard !values.isEmpty else { return nil }
		let sorted = values.sorted()
		let mid = sorted.count / 2
		return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
	}
}

/// The "IS IT WORKING" rows and the week-on-week comparison, from the flow's activity feed.
///
/// The feed holds the newest 50 events (`LoopRunHistory.feedLimit`), so a busy flow's older days
/// may be missing. Every number here is a count of that window; the page says so when it is full.
public enum FlowHealth {
	public enum Tone: Sendable, Equatable { case ok, warn, bad, idle }

	public struct Row: Identifiable, Equatable, Sendable {
		public var label: String
		public var note: String
		public var tone: Tone
		public var id: String { label }
	}

	public static let week: TimeInterval = 7 * 24 * 3600

	private static func inWindow(_ entry: LoopActivityEntry, from start: Date, to end: Date) -> Bool {
		guard let date = entry.createdAt else { return false }
		return date > start && date <= end
	}

	/// Sessions that failed or timed out in the last seven days.
	public static func failedCount(_ activity: [LoopActivityEntry], now: Date) -> Int {
		activity.filter {
			($0.action == "session_failed" || $0.action == "session_timeout")
				&& inWindow($0, from: now.addingTimeInterval(-week), to: now)
		}.count
	}

	/// Runs ok, Needs you, Failed, each with a one-line note.
	public static func rows(loop: LoopSummary, activity: [LoopActivityEntry], now: Date) -> [Row] {
		let recent = activity.filter { inWindow($0, from: now.addingTimeInterval(-week), to: now) }
		let started = recent.filter { $0.action == "session_created" }.count
		let completed = recent.filter { $0.action == "session_completed" }.count
		let failed = failedCount(activity, now: now)
		let runs = max(started, completed + failed)
		let runsRow: Row
		if runs == 0 {
			runsRow = Row(label: "Runs ok", note: "No runs in the last 7 days", tone: .idle)
		} else {
			let tone: Tone = failed == 0 ? .ok : (completed == 0 ? .bad : .warn)
			runsRow = Row(
				label: "Runs ok",
				note: "\(completed) of \(runs) \(runs == 1 ? "run" : "runs") finished in the last 7 days",
				tone: tone)
		}
		let waiting = loop.waitingCount
		let needsRow = Row(
			label: "Needs you",
			note: waiting == 0 ? "Nothing" : "\(waiting) \(waiting == 1 ? "decision" : "decisions") waiting",
			tone: waiting == 0 ? .ok : .warn)
		let failedRow = Row(
			label: "Failed",
			note: failed == 0 ? "None in the last 7 days" : "\(failed) failed in the last 7 days",
			tone: failed == 0 ? .ok : .bad)
		return [runsRow, needsRow, failedRow]
	}

	/// Completed runs in the last seven days minus those in the seven before: the closest the
	/// feed gets to "completed cycles", since it carries no cycle close dates. Nil (show nothing)
	/// when fewer than three completed in the fortnight, or when the feed is full and does not
	/// reach back a fortnight, so the earlier week would read low.
	public static func completedDelta(_ activity: [LoopActivityEntry], now: Date) -> Int? {
		let done = activity.filter { $0.action == "session_completed" }
		let current = done.filter { inWindow($0, from: now.addingTimeInterval(-week), to: now) }.count
		let previous = done.filter {
			inWindow($0, from: now.addingTimeInterval(-2 * week), to: now.addingTimeInterval(-week))
		}.count
		guard current + previous >= 3 else { return nil }
		if activity.count >= LoopRunHistory.feedLimit,
			let oldest = activity.compactMap(\.createdAt).min(), oldest > now.addingTimeInterval(-2 * week)
		{
			return nil
		}
		return current - previous
	}

	/// "+2 vs last week", "-1 vs last week".
	public static func deltaText(_ delta: Int) -> String {
		"\(delta < 0 ? "-" : "+")\(abs(delta)) vs last week"
	}
}

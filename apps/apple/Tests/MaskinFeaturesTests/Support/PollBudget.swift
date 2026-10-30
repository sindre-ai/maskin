/// How long a test may keep polling for a condition, counting only time the machine really gave it.
///
/// A wall-clock deadline is unreliable here: the whole package runs in one process, and the
/// main-actor tests (snapshot renders in particular) queue behind one another, so a test can be kept
/// from running for tens of seconds through no fault of the code it checks. When it wakes, a plain
/// deadline has already passed and it fails a condition that was about to hold. Each poll is
/// credited at most `maxCredit`, so a poll that was held up by a busy main actor spends almost
/// nothing, while a condition that really never holds still runs out after about `total` of polling.
struct PollBudget {
	private var remaining: Duration
	private var last = ContinuousClock.now
	private let maxCredit: Duration

	init(_ total: Duration = .seconds(15), maxCredit: Duration = .milliseconds(25)) {
		remaining = total
		self.maxCredit = maxCredit
	}

	/// Call after each poll's sleep. `false` once the budget is spent.
	mutating func spend() -> Bool {
		let now = ContinuousClock.now
		remaining -= min(now - last, maxCredit)
		last = now
		return remaining > .zero
	}
}

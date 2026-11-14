import Foundation

// MARK: - Billing

public struct BillingUsage: Sendable, Equatable {
	public enum Status: String, Sendable, Equatable {
		case active, pastDue = "past_due", canceled, incomplete
	}
	public var plan: String
	public var status: Status
	public var usedCents: Int
	public var capCents: Int?
	public var creditBalanceCents: Int
	/// Milliseconds until the usage period resets.
	public var resetsInMs: Int?
	/// Nil on a workspace that never went through the card step.
	public var trialState: TrialState?

	public enum TrialState: String, Sendable, Equatable {
		case awaitingCard = "awaiting_card"
		case started
	}

	public init(
		plan: String, status: Status, usedCents: Int, capCents: Int?, creditBalanceCents: Int,
		resetsInMs: Int?, trialState: TrialState? = nil
	) {
		self.plan = plan
		self.status = status
		self.usedCents = usedCents
		self.capCents = capCents
		self.creditBalanceCents = creditBalanceCents
		self.resetsInMs = resetsInMs
		self.trialState = trialState
	}

	/// Signed up through the card step and no card yet: nothing runs until the trial has started.
	public var awaitingCard: Bool { trialState == .awaitingCard }

	public var planLabel: String {
		switch plan {
		case "trial": "Trial"
		case "pro": "Pro"
		case "team": "Team"
		case "enterprise": "Enterprise"
		default: plan.capitalized
		}
	}

	public var statusLabel: String {
		switch status {
		case .active: "Active"
		case .pastDue: "Payment past due"
		case .canceled: "Canceled"
		case .incomplete: "Setup incomplete"
		}
	}

	/// 0...1 of the cap used; nil when the plan has no cap.
	public var usedFraction: Double? {
		guard let capCents, capCents > 0 else { return nil }
		return min(1, Double(usedCents) / Double(capCents))
	}

	// MARK: Percent of the plan (flag trial-card-percent)

	/// How much of the plan is used, as a whole percent. The same rule as `usagePercent` in
	/// `packages/shared/src/plan-pricing.ts` (the web's number): used over the stored cap the server
	/// stops on, rounded down, exactly 100 once the cap is reached. Nil for Enterprise (not metered)
	/// and when no cap is known: no figure is made up.
	public var percent: Int? {
		guard plan != "enterprise", let capCents, capCents > 0 else { return nil }
		if usedCents >= capCents { return 100 }
		return max(0, Int((Double(usedCents) / Double(capCents) * 100).rounded(.down)))
	}

	/// The meter colour: primary under 80%, warning from 80%, error at 100%. The number is always
	/// written next to it, so colour is never the only signal.
	public enum PercentTone: Sendable, Equatable { case primary, warning, error }

	public static let warnPercent = 80

	public var percentTone: PercentTone? {
		guard let percent else { return nil }
		if percent >= 100 { return .error }
		return percent >= Self.warnPercent ? .warning : .primary
	}

	/// "42% of plan used".
	public var percentText: String? { percent.map { "\($0)% of plan used" } }

	/// A balance from an earlier top-up keeps work starting at 100%, unless the plan is not billable.
	private var holdsCredit: Bool {
		status != .pastDue && status != .canceled && creditBalanceCents > 0
	}

	/// At 100% and nothing lets new work start. Not while the period is over (`resetsInMs == 0`):
	/// the trial-ended notice owns the screen then.
	public var isPaused: Bool {
		guard let percent, percent >= 100, !holdsCredit else { return false }
		return resetsInMs != 0
	}

	/// "16 Nov": when the period (the trial, or the month) ends and work can start again.
	public func periodEndLabel(now: Date = Date(), locale: Locale = Locale(identifier: "en_GB")) -> String? {
		guard let ms = resetsInMs, ms > 0 else { return nil }
		let f = DateFormatter()
		f.locale = locale
		f.setLocalizedDateFormatFromTemplate("dMMM")
		return f.string(from: now.addingTimeInterval(TimeInterval(ms) / 1000))
	}

	/// What the 100% screen says, the design spec's words (the same as the web). A trial waits until
	/// it ends, a paid plan until the month rolls over; both can be ended by picking a plan now.
	public func limitCopy(now: Date = Date()) -> (banner: String, button: String, notice: String) {
		let resets = periodEndLabel(now: now)
		if plan == "trial" {
			return (
				"You have used 100% of your trial. New work waits until your trial ends\(resets.map { " on \($0)" } ?? ""), or you can choose a plan now.",
				"Choose a plan",
				"Your agents are paused. Your plan is used up. Work starts again when you choose a plan."
			)
		}
		let name = ["starter", "pro", "team", "ultra"].contains(plan) ? planLabel : "plan"
		return (
			"You have used 100% of your \(name) plan. New work waits until \(resets ?? "next month"), or you can change plan now.",
			"Change plan",
			"Your agents are paused. Your plan is used up. Work starts again on \(resets ?? "the next period"), or when you change plan."
		)
	}

	public static func dollars(_ cents: Int, locale: Locale = .current) -> String {
		let value = Double(cents) / 100
		let whole = cents % 100 == 0
		return value.formatted(
			.currency(code: "USD").locale(locale).precision(.fractionLength(whole ? 0 : 2)))
	}

	/// "Resets in 5 days", "Resets in 3 hours", or nil.
	public var resetsText: String? {
		guard let ms = resetsInMs, ms > 0 else { return nil }
		let hours = ms / 3_600_000
		if hours >= 48 { return "Resets in \(hours / 24) days" }
		if hours >= 1 { return "Resets in \(hours) hour\(hours == 1 ? "" : "s")" }
		return "Resets within the hour"
	}
}

// MARK: - Schema (object types, properties, statuses)

public struct PropertyDefinition: Sendable, Equatable, Identifiable {
	public enum Kind: String, Sendable, Equatable, CaseIterable {
		case text, number, date, `enum`, boolean
		public var label: String {
			switch self {
			case .text: "Text"
			case .number: "Number"
			case .date: "Date"
			case .enum: "Choice"
			case .boolean: "Yes / no"
			}
		}
	}
	public var id: String { name }
	public var name: String
	public var kind: Kind
	public var isRequired: Bool
	public var values: [String]

	public init(name: String, kind: Kind, isRequired: Bool = false, values: [String] = []) {
		self.name = name
		self.kind = kind
		self.isRequired = isRequired
		self.values = values
	}
}

/// The schema-bearing slice of `workspaces.settings`. Keys the app doesn't model are never sent
/// back, so nothing else in settings can be clobbered.
public struct WorkspaceSchema: Sendable, Equatable {
	public enum Key: Sendable, Hashable { case fieldDefinitions, statuses, displayNames }
	public var fieldDefinitions: [String: [PropertyDefinition]]
	public var statuses: [String: [String]]
	public var displayNames: [String: String]

	public init(
		fieldDefinitions: [String: [PropertyDefinition]] = [:], statuses: [String: [String]] = [:],
		displayNames: [String: String] = [:]
	) {
		self.fieldDefinitions = fieldDefinitions
		self.statuses = statuses
		self.displayNames = displayNames
	}

	/// Every object type the workspace knows: core types first, then the rest alphabetically.
	public var types: [String] {
		let all = Set(statuses.keys).union(displayNames.keys).union(fieldDefinitions.keys)
		let core = ["insight", "bet", "task", "loop"]
		return core.filter(all.contains) + all.subtracting(core).sorted()
	}

	public func displayName(for type: String) -> String {
		if let name = displayNames[type], !name.isEmpty { return name }
		return type.replacingOccurrences(of: "_", with: " ").capitalized
	}
}

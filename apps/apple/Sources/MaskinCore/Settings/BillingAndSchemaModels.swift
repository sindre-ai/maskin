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

	public init(
		plan: String, status: Status, usedCents: Int, capCents: Int?, creditBalanceCents: Int,
		resetsInMs: Int?
	) {
		self.plan = plan
		self.status = status
		self.usedCents = usedCents
		self.capCents = capCents
		self.creditBalanceCents = creditBalanceCents
		self.resetsInMs = resetsInMs
	}

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

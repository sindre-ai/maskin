import Foundation

/// How a new property's value is written to an object's metadata, which only holds strings.
public enum PropertyValueEncoding {
	/// A date as `yyyy-MM-dd`, the form the web and the due-date parser read.
	public static func dateString(_ date: Date, calendar: Calendar = .current) -> String {
		let parts = calendar.dateComponents([.year, .month, .day], from: date)
		return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
	}

	public static func boolString(_ on: Bool) -> String { on ? "true" : "false" }

	/// The trimmed value for a kind, or nil when it is empty or not valid for that kind.
	public static func normalized(_ raw: String, kind: PropertyDefinition.Kind) -> String? {
		let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !value.isEmpty else { return nil }
		if kind == .number {
			let cleaned = value.replacingOccurrences(of: ",", with: ".")
			return Double(cleaned) == nil ? nil : cleaned
		}
		return value
	}
}

import Foundation

/// How an object type reads on a For you card: the workspace schema's display name when it has
/// one, else the key made readable. A raw key never shows, and nothing says "Loop": a flow object
/// reads "Flow".
public enum ForYouTypeLabel {
	public static func label(for type: String, displayNames: [String: String] = [:]) -> String {
		let named = displayNames[type]?.trimmingCharacters(in: .whitespacesAndNewlines)
		let base = (named?.isEmpty == false ? named : nil)
			?? type.replacingOccurrences(of: "_", with: " ").capitalized
		return base.replacingOccurrences(of: "Loop", with: "Flow").replacingOccurrences(of: "loop", with: "flow")
	}
}

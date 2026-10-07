import Foundation

/// Which options the watch shows for a decision: at most two, the recommended one first. The rest
/// are an iPhone job ("More on iPhone").
public enum WatchDecisionOptions {
	public static let limit = 2

	public static func visible(_ options: [DecisionOption]) -> [DecisionOption] {
		guard options.count > limit else { return options }
		let recommended = options.first(where: \.recommended) ?? options[0]
		let rest = options.filter { $0.id != recommended.id }
		return [recommended] + rest.prefix(limit - 1)
	}
}

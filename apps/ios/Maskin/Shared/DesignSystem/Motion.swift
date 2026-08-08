import SwiftUI

/// Port of `tokens/motion.css`.
enum MaskinMotion {
	static let fast: Double = 0.15 // color/border hovers
	static let base: Double = 0.2 // shadow, background, transform
	static let slow: Double = 0.25 // nav state, panel entrance

	static let easeOut = Animation.timingCurve(0.16, 1, 0.3, 1, duration: base) // submit affordances
	static let standard = Animation.easeInOut(duration: base)
	static let panel = Animation.easeInOut(duration: slow)

	/// The card-stack swipe threshold used by the "For you" queue (matches the prototype's
	/// `dx > 112` / `dx < -112` commit thresholds).
	static let swipeCommitDistance: CGFloat = 112
}

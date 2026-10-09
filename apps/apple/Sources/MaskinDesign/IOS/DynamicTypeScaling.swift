import SwiftUI

/// How text and fixed-height chrome respond to Dynamic Type (Specs-C-D "Dynamic Type"). Pure
/// functions of the size category so they test without a view.
public enum MaskinScaling {
	/// Mono labels scale up to here and then stop: past it a 10pt tracked caps label stops being a label.
	public static let monoLabelCeiling: DynamicTypeSize = .xxxLarge

	/// The size a mono label renders at: the environment's, but never above the ceiling.
	public static func monoLabelSize(_ size: DynamicTypeSize) -> DynamicTypeSize {
		min(size, monoLabelCeiling)
	}

	/// A briefing card is 176pt tall and grows to 220pt at accessibility sizes so the headline fits.
	public static let briefingCardHeight: CGFloat = 176
	public static let briefingCardHeightAccessibility: CGFloat = 220

	public static func briefingCardHeight(for size: DynamicTypeSize) -> CGFloat {
		size.isAccessibilitySize ? briefingCardHeightAccessibility : briefingCardHeight
	}
}

extension View {
	/// Caps this view's Dynamic Type at the mono-label ceiling. For a label built straight from
	/// `MaskinTypeface.mono` rather than `.maskinText(.microLabel)`, which does this itself.
	public func maskinMonoLabelScale() -> some View {
		dynamicTypeSize(...MaskinScaling.monoLabelCeiling)
	}
}

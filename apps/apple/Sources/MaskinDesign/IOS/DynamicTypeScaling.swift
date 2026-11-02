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

/// A fixed-point-size glyph or icon label that still follows Dynamic Type: the point size is a
/// `ScaledMetric`, so SF Symbols and one-off glyphs grow with the reader's text size like the
/// type roles do. Use instead of `.font(.system(size:))`.
private struct MaskinSymbolFont: ViewModifier {
	@ScaledMetric private var size: CGFloat
	private let weight: Font.Weight

	init(size: CGFloat, weight: Font.Weight, style: Font.TextStyle) {
		_size = ScaledMetric(wrappedValue: size, relativeTo: style)
		self.weight = weight
	}

	func body(content: Content) -> some View {
		content.font(.system(size: size, weight: weight))
	}
}

extension View {
	/// Scaled system font at `size` points (see `MaskinSymbolFont`).
	public func maskinSymbol(
		_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body
	) -> some View {
		modifier(MaskinSymbolFont(size: size, weight: weight, style: style))
	}
}

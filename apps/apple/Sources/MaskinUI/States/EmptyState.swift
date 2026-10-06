import MaskinDesign
import SwiftUI

/// Centered placeholder for an empty list or screen, with an optional action.
public struct EmptyState<Action: View>: View {
	private let symbol: String?
	private let title: String
	private let message: String?
	private let action: Action

	public init(
		symbol: String? = nil, title: String, message: String? = nil, @ViewBuilder action: () -> Action
	) {
		self.symbol = symbol
		self.title = title
		self.message = message
		self.action = action()
	}

	public var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			if let symbol {
				Image(systemName: symbol)
					.font(.system(size: MaskinSpace.s13, weight: .regular))
					.foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			Text(title).maskinText(.headline).foregroundStyle(MaskinColor.ink).multilineTextAlignment(.center)
			if let message {
				Text(message).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).multilineTextAlignment(.center)
			}
			action
		}
		.frame(maxWidth: .infinity)
		.padding(MaskinSpace.s12)
		.accessibilityElement(children: .contain)
	}
}

extension EmptyState where Action == EmptyView {
	public init(symbol: String? = nil, title: String, message: String? = nil) {
		self.init(symbol: symbol, title: title, message: message) { EmptyView() }
	}
}

#Preview("EmptyState — light") { EmptyGallery().preferredColorScheme(.light) }
#Preview("EmptyState — dark") { EmptyGallery().preferredColorScheme(.dark) }

private struct EmptyGallery: View {
	var body: some View {
		EmptyState(symbol: "tray", title: "Nothing needs you", message: "Agents are working. Decisions will land here.") {
			Button("Refresh") {}.buttonStyle(SecondaryActionButtonStyle())
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero))
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}

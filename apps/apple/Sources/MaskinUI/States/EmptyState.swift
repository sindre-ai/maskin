import MaskinDesign
import SwiftUI

/// How an `EmptyState` draws its icon and title.
public enum EmptyStateStyle: Sendable {
	/// A bare 28pt symbol over a 17pt semibold title (the original form).
	case plain
	/// A 60pt `fill` circle holding the symbol, a 19pt bold title and a 15pt line (spec 7 §6).
	case circled
}

/// Centered placeholder for an empty list or screen, with an optional action.
public struct EmptyState<Action: View>: View {
	private let symbol: String?
	private let title: String
	private let message: String?
	private let style: EmptyStateStyle
	private let action: Action

	public init(
		symbol: String? = nil, title: String, message: String? = nil, style: EmptyStateStyle = .plain,
		@ViewBuilder action: () -> Action
	) {
		self.symbol = symbol
		self.title = title
		self.message = message
		self.style = style
		self.action = action()
	}

	public var body: some View {
		switch style {
		case .plain: plain
		case .circled: circled
		}
	}

	private var circled: some View {
		VStack(spacing: 0) {
			if let symbol {
				Image(systemName: symbol)
					.maskinSymbol(MaskinFontSize.t26, weight: .regular)
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s13, height: MaskinSpace.s14 + MaskinSpace.s13)
					.background(MaskinSurface.fill, in: Circle())
					.accessibilityHidden(true)
					.padding(.bottom, MaskinSpace.s9)
			}
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t19, weight: .bold, relativeTo: .title3))
				.tracking(-0.018 * MaskinFontSize.t19)
				.foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.center)
			if let message {
				Text(message)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.center)
					.lineSpacing(MaskinSpace.s1 + 1)
					.padding(.top, MaskinSpace.s3)
			}
			action.padding(.top, MaskinSpace.s10)
		}
		.frame(maxWidth: .infinity)
		.padding(.horizontal, MaskinSpace.s14 + MaskinSpace.s2)
		.padding(.top, MaskinSpace.s14 + MaskinSpace.s2)
		.padding(.bottom, MaskinSpace.s11)
		.accessibilityElement(children: .contain)
	}

	private var plain: some View {
		VStack(spacing: MaskinSpace.s7) {
			if let symbol {
				Image(systemName: symbol)
					.maskinSymbol(MaskinSpace.s13, weight: .regular)
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
	public init(symbol: String? = nil, title: String, message: String? = nil, style: EmptyStateStyle = .plain) {
		self.init(symbol: symbol, title: title, message: message, style: style) { EmptyView() }
	}
}

#Preview("EmptyState — light") { EmptyGallery().preferredColorScheme(.light) }
#Preview("EmptyState — dark") { EmptyGallery().preferredColorScheme(.dark) }

private struct EmptyGallery: View {
	var body: some View {
		VStack(spacing: MaskinSpace.s9) {
			EmptyState(symbol: "tray", title: "Nothing needs you", message: "Agents are working. Decisions will land here.") {
				Button("Refresh") {}.buttonStyle(SecondaryActionButtonStyle())
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero))
			EmptyState(
				symbol: "bubble.left.and.bubble.right", title: "Nothing here yet",
				message: "Start a conversation with an agent or a teammate.", style: .circled
			) {
				Button("New conversation") {}.buttonStyle(SecondaryActionButtonStyle())
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}

import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Team list's empty states (spec 7 §6): MaskinUI's circled `EmptyState` with the copy from
/// `TeamLayout.Empty` and a 44pt ink pill; the action is the screen's.
struct TeamEmptyState: View {
	let empty: TeamLayout.Empty
	var onSuggestion: (String) -> Void = { _ in }
	let action: () -> Void

	/// First messages for a workspace with no conversations yet; they go to the Chief of Staff.
	static let suggestions = ["What should I focus on today?", "Help me set up my first agent"]

	var body: some View {
		EmptyState(symbol: symbol, title: empty.title, message: empty.message, style: .circled) {
			VStack(spacing: MaskinSpace.s5) {
				Button(empty.action, action: action).buttonStyle(InkPillButtonStyle())
				if empty == .nothing {
					ForEach(Self.suggestions, id: \.self) { text in
						Button(text) { onSuggestion(text) }
							.buttonStyle(.secondaryAction)
					}
				}
			}
		}
	}

	private var symbol: String {
		switch empty {
		case .nothing: "bubble.left.and.bubble.right"
		case .noResults: "magnifyingglass"
		case .caughtUp: "checkmark"
		case .noKind(.flows): "arrow.triangle.2.circlepath"
		case .noKind(.groups): "person.2"
		case .noKind: "person"
		}
	}
}

/// A 44pt ink pill that hugs its label: the empty states' call to action.
struct InkPillButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
			.foregroundStyle(MaskinSurface.onInverse)
			.padding(.horizontal, MaskinSpace.s11)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(MaskinSurface.inverse, in: Capsule())
			.opacity(configuration.isPressed ? 0.7 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Capsule())
	}
}

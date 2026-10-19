import MaskinDesign
import SwiftUI

/// The Search header on iPhone: a translucent field on the gradient and a Cancel that leaves the
/// tab.
struct SearchFieldHeader: View {
	@Binding var query: String
	var focused: FocusState<Bool>.Binding
	let onSubmit: () -> Void
	let onCancel: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "magnifyingglass")
					.maskinSymbol(16, weight: .semibold)
					.foregroundStyle(MaskinScreenHeader.kicker)
					.accessibilityHidden(true)
				TextField(
					"", text: $query,
					prompt: Text("Flows, objects, chats").foregroundStyle(.white.opacity(0.6))
				)
				.maskinText(.body)
				.foregroundStyle(.white)
				.tint(.white)
				.focused(focused)
				.submitLabel(.search)
				.onSubmit(onSubmit)
				.autocorrectionDisabled()
				.noAutocapitalization()
				.accessibilityLabel("Search")
			}
			.padding(.horizontal, MaskinSpace.s8)
			.frame(height: MaskinSpace.s14 + MaskinSpace.s9)
			.background(Capsule().fill(MaskinScreenHeader.buttonFill))
			.overlay(Capsule().strokeBorder(MaskinScreenHeader.buttonRing, lineWidth: 1))
			Button("Cancel", action: onCancel)
				.maskinText(.body)
				.fontWeight(.semibold)
				.foregroundStyle(.white)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s9)
	}
}

extension View {
	fileprivate func noAutocapitalization() -> some View {
		#if os(iOS)
			return textInputAutocapitalization(.never)
		#else
			return self
		#endif
	}
}

import MaskinCore
import MaskinDesign
import SwiftUI

extension View {
	/// The page's own search: hidden until the magnifier in the top bar is tapped, then a field pinned
	/// above the content that filters this page only. Cancel (or an empty close) clears the filter.
	func pageSearch(text: Binding<String>, isPresented: Binding<Bool>, prompt: String) -> some View {
		modifier(PageSearchModifier(text: text, isPresented: isPresented, prompt: prompt))
	}
}

private struct PageSearchModifier: ViewModifier {
	@Binding var text: String
	@Binding var isPresented: Bool
	let prompt: String
	@FocusState private var focused: Bool

	func body(content: Content) -> some View {
		content
			.safeAreaInset(edge: .top, spacing: 0) {
				if isPresented {
					HStack(spacing: MaskinSpace.s5) {
						HStack(spacing: MaskinSpace.s4) {
							Image(systemName: "magnifyingglass")
								.foregroundStyle(MaskinColor.ink4)
								.accessibilityHidden(true)
							TextField(prompt, text: $text)
								.focused($focused)
								.submitLabel(.search)
								.autocorrectionDisabled()
								#if os(iOS)
									.textInputAutocapitalization(.never)
								#endif
							if !text.isEmpty {
								Button {
									text = ""
								} label: {
									Image(systemName: "xmark.circle.fill").foregroundStyle(MaskinColor.ink5)
								}
								.buttonStyle(.plain)
								.accessibilityLabel("Clear")
							}
						}
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.background(MaskinSurface.fill, in: Capsule())
						Button("Cancel") {
							text = ""
							isPresented = false
						}
						.foregroundStyle(MaskinColor.ink)
						.frame(minHeight: MaskinSpace.touchMin)
					}
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s3)
					.transition(.move(edge: .top).combined(with: .opacity))
					.onAppear { focused = true }
				}
			}
			.animation(MaskinMotion.quick, value: isPresented)
	}
}

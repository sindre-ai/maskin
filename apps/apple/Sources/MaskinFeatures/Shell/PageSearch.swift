import MaskinCore
import MaskinDesign
import SwiftUI

extension View {
	/// The page's own search: hidden until the magnifier in the top bar is tapped, or the list is
	/// pulled down past the top and let go, then a field pinned above the content that filters this
	/// page only. Cancel (or an empty close) clears the filter. Pulling down is search here, so these
	/// pages have no pull-to-refresh: their data arrives live over the event stream.
	func pageSearch(text: Binding<String>, isPresented: Binding<Bool>, prompt: String) -> some View {
		modifier(PageSearchModifier(text: text, isPresented: isPresented, prompt: prompt))
	}
}

private struct PageSearchModifier: ViewModifier {
	@Binding var text: String
	@Binding var isPresented: Bool
	let prompt: String
	@FocusState private var focused: Bool

	/// How far past the top the list must be pulled before letting go opens search.
	static let pullThreshold: CGFloat = 70
	/// The pill and the close button are both 52 pt tall.
	static let fieldHeight: CGFloat = 52
	/// How far the content is pulled past its top right now; 0 while at rest or scrolled.
	@State private var overscroll: CGFloat = 0

	func body(content: Content) -> some View {
		content
			.pullDownGesture(overscroll: $overscroll, threshold: Self.pullThreshold) {
				guard !isPresented else { return }
				MaskinHaptics.play(.selection)
				isPresented = true
			}
			.safeAreaInset(edge: .top, spacing: 0) {
				if isPresented {
					// iOS glass: a 52 pt pill field and a separate 52 pt round close button, 10 pt apart.
					HStack(spacing: MaskinSpace.s5) {
						HStack(spacing: MaskinSpace.s5) {
							Image(systemName: "magnifyingglass")
								.foregroundStyle(MaskinColor.ink4)
								.accessibilityHidden(true)
							TextField(prompt, text: $text)
								.focused($focused)
								.font(MaskinTypeface.sans(MaskinFontSize.t17, relativeTo: .body))
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
						.padding(.horizontal, MaskinSpace.s9)
						.frame(height: Self.fieldHeight)
						.maskinGlassCapsule(interactive: true)
						Button {
							text = ""
							isPresented = false
						} label: {
							Image(systemName: "xmark")
								.maskinSymbol(MaskinFontSize.t17, weight: .semibold)
								.foregroundStyle(MaskinColor.ink)
								.frame(width: Self.fieldHeight, height: Self.fieldHeight)
								.maskinGlass(in: Circle(), interactive: true)
								.contentShape(Circle())
						}
						.buttonStyle(.plain)
						.accessibilityLabel("Cancel")
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

extension View {
	/// Calls `onPulled` when the person lets go of a list that is pulled down past `threshold`.
	/// Needs iOS 18's scroll phases; earlier systems keep only the top-bar button.
	@ViewBuilder
	fileprivate func pullDownGesture(
		overscroll: Binding<CGFloat>, threshold: CGFloat, onPulled: @escaping () -> Void
	) -> some View {
		if #available(iOS 18, macOS 15, *) {
			self
				.onScrollGeometryChange(for: CGFloat.self) { geometry in
					max(0, -(geometry.contentOffset.y + geometry.contentInsets.top))
				} action: { _, pulled in
					overscroll.wrappedValue = pulled
				}
				.onScrollPhaseChange { old, new in
					if old == .interacting, new != .interacting, overscroll.wrappedValue >= threshold { onPulled() }
				}
		} else {
			self
		}
	}
}

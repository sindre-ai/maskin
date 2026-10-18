import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	/// Team search (spec 7 §6): a magnifier in the top-nav glass cluster that expands into a
	/// full-width search field with ✕ and Cancel, keyboard up at once. That is the system's
	/// minimized search on iOS 26, so it is used as-is; it filters every section live by name and
	/// preview, and Cancel clears the query.
	func teamSearch(text: Binding<String>, isPresented: Binding<Bool>) -> some View {
		searchable(text: text, isPresented: isPresented, prompt: "Search Team")
			.searchMinimized()
			// Closing the field collapses it back to the icon; a leftover query would keep it open.
			.onChange(of: isPresented.wrappedValue) { if !isPresented.wrappedValue, !text.wrappedValue.isEmpty { text.wrappedValue = "" } }
	}
}

/// The filter chips row: All · Unread n · People · Agents · Groups · Flows. 34pt, `inverse` when
/// on. Shown only when the Display menu turns chips on.
struct TeamFilterChips: View {
	@Binding var chip: TeamFilterChip
	let unreadCount: Int

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4 - 1) {
				ForEach(TeamFilterChip.allCases, id: \.self) { item in
					let on = item == chip
					Button {
						MaskinHaptics.play(.selection)
						chip = item
					} label: {
						HStack(spacing: MaskinSpace.s4 - 1) {
							Text(item.label)
								.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
							if item == .unread, unreadCount > 0 {
								Text("\(unreadCount)")
									.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
									.opacity(0.7)
							}
						}
						.foregroundStyle(on ? MaskinSurface.onInverse : MaskinColor.ink2)
						.padding(.horizontal, MaskinSpace.s8)
						.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
						.background(on ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityAddTraits(on ? [.isSelected] : [])
					.accessibilityLabel(item == .unread && unreadCount > 0 ? "Unread, \(unreadCount)" : item.label)
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
		.scrollClipDisabled()
	}
}

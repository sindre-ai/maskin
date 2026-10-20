import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	/// Team search (spec 7 §6): a field that stays tucked away until the person pulls the list
	/// down, so the top bar carries no search icon. It filters every section live by name and
	/// preview. A leftover query is cleared when the field closes.
	func teamSearch(text: Binding<String>) -> some View {
		#if os(iOS)
			searchable(text: text, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search Team")
		#else
			searchable(text: text, prompt: "Search Team")
		#endif
	}
}

/// The filter chips row: All · Unread n · People · Agents · Groups. 34pt, `inverse` when
/// on. Shown only when the Display menu turns chips on.
struct TeamFilterChips: View {
	@Binding var chip: TeamFilterChip
	let unreadCount: Int

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4 - 1) {
				ForEach(TeamFilterChip.allCases.filter { $0 != .flows }, id: \.self) { item in
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

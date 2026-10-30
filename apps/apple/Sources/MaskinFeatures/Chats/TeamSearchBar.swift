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

/// The filter chips row: All · Unread n · Threads n · Pinned · People · Agents · Groups. 34pt, `inverse` when
/// on. Shown only when the Display menu turns chips on.
struct TeamFilterChips: View {
	@Binding var chip: TeamFilterChip
	let unreadCount: Int
	/// Threads with replies you have not read; the Threads chip shows it.
	var threadsUnread = 0
	/// Opens the Threads screen. Threads are a place, not a filter, so the chip does not stay selected.
	var onThreads: (() -> Void)?
	/// On the bottom glass pill: unselected chips draw no fill of their own, the row fades at both
	/// ends, and the selected chip is scrolled into view when the row appears.
	var onGlass = false

	/// The filter chips in order; Threads sits after Unread.
	private static let chips = TeamFilterChip.allCases.filter { $0 != .flows }

	@ViewBuilder
	private func chipButton(_ item: TeamFilterChip) -> some View {
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
			.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s1)
			.background(on ? MaskinSurface.inverse : (onGlass ? Color.clear : MaskinSurface.card), in: Capsule())
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(on ? [.isSelected] : [])
		.accessibilityLabel(item == .unread && unreadCount > 0 ? "Unread, \(unreadCount) unread" : item.label)
		.id(item)
	}

	var body: some View {
		ScrollViewReader { proxy in
			row.onAppear { if onGlass { proxy.scrollTo(chip, anchor: .center) } }
		}
	}

	private var row: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4 - 1) {
				ForEach(Self.chips.prefix(2), id: \.self) { chipButton($0) }
				if let onThreads {
					Button {
						MaskinHaptics.play(.selection)
						onThreads()
					} label: {
						HStack(spacing: MaskinSpace.s4 - 1) {
							Text("Threads")
								.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
							if threadsUnread > 0 {
								Text("\(threadsUnread)")
									.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
									.opacity(0.7)
							}
						}
						.foregroundStyle(MaskinColor.ink2)
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s1)
						.background(onGlass ? Color.clear : MaskinSurface.card, in: Capsule())
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel(threadsUnread > 0 ? "Threads, \(threadsUnread) unread" : "Threads")
				}
				ForEach(Self.chips.dropFirst(2), id: \.self) { chipButton($0) }
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
		.scrollClipDisabled()
		.modifier(GlassRowExtras(isOn: onGlass))
	}
}

/// What the bottom pill adds to the chip row: a fade at both ends (the row scrolls sideways) and
/// one VoiceOver group around the chips.
private struct GlassRowExtras: ViewModifier {
	let isOn: Bool

	@ViewBuilder
	func body(content: Content) -> some View {
		if isOn {
			content
				.mask {
					HStack(spacing: 0) {
						LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
							.frame(width: MaskinSpace.s7)
						Rectangle()
						LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
							.frame(width: MaskinSpace.s7)
					}
				}
				.accessibilityElement(children: .contain)
				.accessibilityLabel("Filter conversations")
		} else {
			content
		}
	}
}

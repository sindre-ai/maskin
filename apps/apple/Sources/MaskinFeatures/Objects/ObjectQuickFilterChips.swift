import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Starred · New last 7 days · Working now" under the tabs (handoff 13). They narrow the rows
/// loaded so far, and say so while one is on and more rows could still load.
struct ObjectQuickFilterChips: View {
	let store: ObjectsStore

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s3) {
					ForEach(ObjectsQuickFilter.allCases) { filter in chip(filter) }
				}
				.padding(.horizontal, MaskinSpace.s9)
			}
			if !store.quickFilters.isEmpty, store.hasMore {
				Text("Looking through the \(store.objects.count) items loaded so far.")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
					.padding(.horizontal, MaskinSpace.s9)
			}
		}
	}

	private func chip(_ filter: ObjectsQuickFilter) -> some View {
		let on = store.quickFilters.contains(filter)
		return Button {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.quick) {
				if on { store.quickFilters.remove(filter) } else { store.quickFilters.insert(filter) }
			}
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				if let symbol = filter.symbol {
					Image(systemName: symbol).maskinSymbol(MaskinFontSize.t12, weight: .semibold)
				}
				Text(filter.label).maskinText(.subhead).fontWeight(.semibold)
			}
			.foregroundStyle(on ? MaskinSurface.onInverse : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s7)
			.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
			.background(on ? MaskinSurface.inverse : Color.clear, in: Capsule())
			.overlay(Capsule().strokeBorder(on ? Color.clear : MaskinSurface.line, lineWidth: 1))
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(filter.label)
		.accessibilityAddTraits(on ? [.isSelected] : [])
	}
}

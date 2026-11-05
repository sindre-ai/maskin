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
					// With the type tabs off, Needs you lives here (it is the tabs' first tab otherwise).
					if !store.display.showsTypeTabs { needsYouChip }
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

	private var needsYouChip: some View {
		let on = store.display.needsYouOnly
		let count = store.needsYouCount
		return Button {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.quick) { store.setNeedsYouOnly(!on) }
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Text("Needs you").maskinText(.subhead).fontWeight(.semibold)
				if count > 0 {
					Text("\(count)").maskinText(.caption).fontWeight(.bold).monospacedDigit()
						.foregroundStyle(on ? MaskinSurface.onInverse : MaskinColor.sigInk)
				}
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
		.accessibilityLabel(count > 0 ? "Needs you, \(count)" : "Needs you")
		.accessibilityAddTraits(on ? [.isSelected] : [])
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

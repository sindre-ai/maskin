import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Go to" (handoff 8): Needs you / All objects / Favourites, then a two-column grid of the
/// workspace's types with their counts. Types come from the schema, never a fixed list. Saved
/// views are not offered: the API has no saved-view resource yet.
struct ObjectsGoToSheet: View {
	@Bindable var store: ObjectsStore
	@Environment(\.dismiss) private var dismiss

	private let columns = [
		GridItem(.flexible(), spacing: MaskinSpace.s4), GridItem(.flexible(), spacing: MaskinSpace.s4),
	]

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				VStack(spacing: 0) {
					row("exclamationmark.triangle", "Needs you", badge: store.needsYouCount, selected: store.tab == .needsYou) {
						await store.setStarredOnly(false)
						await store.select(.needsYou)
					}
					Divider().overlay(MaskinSurface.separator)
					row("square.stack.3d.up", "All objects", selected: store.tab == .all && !store.starredOnly) {
						await store.setStarredOnly(false)
						await store.select(.all)
					}
					Divider().overlay(MaskinSurface.separator)
					row("star", "Favourites", selected: store.starredOnly) {
						await store.select(.all)
						await store.setStarredOnly(true)
					}
				}
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
				Text("Types").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
					.accessibilityAddTraits(.isHeader)
				LazyVGrid(columns: columns, spacing: MaskinSpace.s4) {
					ForEach(store.presentTypes, id: \.self) { type in
						typeCell(type)
					}
				}
			}
			.padding(MaskinSpace.s9)
		}
		.ambientBackground()
		.presentationDetents([.medium, .large])
	}

	private func row(
		_ symbol: String, _ title: String, badge: Int = 0, selected: Bool,
		_ action: @escaping () async -> Void
	) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			dismiss()
			Task { await action() }
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: symbol).maskinSymbol(MaskinFontSize.t16)
					.foregroundStyle(MaskinColor.ink3).frame(width: MaskinSpace.s12)
				Text(title).maskinText(.body).foregroundStyle(MaskinColor.ink)
				if badge > 0 { needsBadge(badge) }
				Spacer()
				if selected {
					Image(systemName: "checkmark").maskinSymbol(MaskinFontSize.t14, weight: .semibold)
						.foregroundStyle(MaskinColor.ink)
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private func typeCell(_ type: String) -> some View {
		let selected = store.tab == .type(type)
		let name = ObjectTypeOrder.plural(store.directory.typeName(type))
		let needs = store.typeNeedsYou[type] ?? 0
		return Button {
			MaskinHaptics.play(.selection)
			dismiss()
			Task {
				await store.setStarredOnly(false)
				await store.select(.type(type))
			}
		} label: {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: ObjectTypeOrder.symbol(for: type)).maskinSymbol(MaskinFontSize.t15)
					.foregroundStyle(MaskinColor.ink3)
				Text(name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Spacer(minLength: MaskinSpace.s2)
				if needs > 0 { needsBadge(needs) }
				if let count = store.typeCounts[type] {
					Text("\(count)\(store.hasMore && store.typeFilter == nil ? "+" : "")")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
			}
			.padding(.horizontal, MaskinSpace.s7)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
			.background(
				selected ? MaskinSurface.fillStrong : MaskinSurface.card,
				in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private func needsBadge(_ count: Int) -> some View {
		Text("\(count)")
			.maskinText(.caption).fontWeight(.bold)
			.foregroundStyle(MaskinColor.sigInk)
			.padding(.horizontal, MaskinSpace.s3)
			.padding(.vertical, MaskinSpace.s1)
			.background(MaskinColor.sigTint, in: Capsule())
			.accessibilityLabel("\(count) need you")
	}
}

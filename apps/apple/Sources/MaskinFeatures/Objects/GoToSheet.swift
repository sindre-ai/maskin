import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Go to sheet, from the large title's ▾: Needs you / All objects / Favourites, every type as
/// a 2-column grid of 44pt rows (glyph, name, Patina "needs you" badge, count), then saved views.
struct GoToSheet: View {
	let store: ObjectsStore
	var onSelect: (ObjectsScope) -> Void
	var onRemoveSavedView: ((String) -> Void)?

	@Environment(\.dismiss) private var dismiss

	var body: some View {
		ScrollView {
			GoToContent(
				current: store.scope, needsYou: store.needsYouCount, total: store.totalCountLabel,
				favourites: store.favouritesCount, types: store.typeSummaries,
				savedViews: store.savedViews.views.map { ($0, store.count(of: $0)) },
				onSelect: { scope in
					MaskinHaptics.play(.selection)
					onSelect(scope)
					dismiss()
				},
				onRemoveSavedView: onRemoveSavedView)
		}
		.ambientBackground(showsBottom: false)
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}
}

/// The sheet's body as plain values, so it renders in snapshots.
struct GoToContent: View {
	let current: ObjectsScope
	let needsYou: Int
	let total: String
	let favourites: Int
	let types: [ObjectTypeSummary]
	var savedViews: [(view: SavedView, count: Int)] = []
	var onSelect: (ObjectsScope) -> Void = { _ in }
	var onRemoveSavedView: ((String) -> Void)?

	private let columns = [GridItem(.flexible(), spacing: MaskinSpace.s3), GridItem(.flexible(), spacing: MaskinSpace.s3)]

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("Go to")
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s2)
				.accessibilityAddTraits(.isHeader)

			VStack(spacing: 0) {
				viewRow(.needsYou, symbol: "hand.raised", label: "Needs you", count: needsYou > 0 ? "\(needsYou)" : nil, signal: true)
				Divider().overlay(MaskinSurface.separator)
				viewRow(.all, symbol: "square.stack.3d.up", label: "All objects", count: total)
				Divider().overlay(MaskinSurface.separator)
				viewRow(.favourites, symbol: "star", label: "Favourites", count: favourites > 0 ? "\(favourites)" : nil)
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
			.padding(.top, MaskinSpace.s7)

			sectionLabel("Types")
			LazyVGrid(columns: columns, spacing: MaskinSpace.s3) {
				ForEach(types) { type in
					typeCell(type)
				}
			}

			if !savedViews.isEmpty {
				sectionLabel("Saved views")
				VStack(spacing: 0) {
					ForEach(Array(savedViews.enumerated()), id: \.element.view.id) { index, item in
						if index > 0 { Divider().overlay(MaskinSurface.separator) }
						savedRow(item.view, count: item.count)
					}
				}
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.top, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s12)
	}

	private func sectionLabel(_ text: String) -> some View {
		Text(text)
			.maskinText(.caption)
			.fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink5)
			.padding(.horizontal, MaskinSpace.s2)
			.padding(.top, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s4)
			.accessibilityAddTraits(.isHeader)
	}

	private func viewRow(_ scope: ObjectsScope, symbol: String, label: String, count: String?, signal: Bool = false) -> some View {
		let active = current == scope
		return Button {
			onSelect(scope)
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: symbol)
					.maskinSymbol(MaskinFontSize.t17, weight: .regular)
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s11)
				Text(label)
					.maskinText(.body)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
				Spacer(minLength: 0)
				if let count {
					Text(count)
						.maskinText(.subhead)
						.fontWeight(signal ? .semibold : .regular)
						.monospacedDigit()
						.foregroundStyle(signal ? MaskinColor.sigInk : MaskinColor.ink5)
				}
			}
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.s12 * 2)
			.background(active ? MaskinSurface.fill : Color.clear)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(count.map { "\(label), \($0)" } ?? label)
		.accessibilityAddTraits(active ? [.isSelected] : [])
	}

	private func typeCell(_ type: ObjectTypeSummary) -> some View {
		let scope = ObjectsScope.type(type.id)
		let active = current == scope
		return Button {
			onSelect(scope)
		} label: {
			HStack(spacing: MaskinSpace.s4 + 1) {
				Image(systemName: MaskinObjectType.glyph(for: type.id))
					.maskinSymbol(MaskinFontSize.t16, weight: .regular)
					.foregroundStyle(MaskinColor.ink3)
				Text(type.label)
					.maskinText(.subhead)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				Spacer(minLength: 0)
				if type.needsYou > 0 {
					Text("\(type.needsYou)")
						.maskinText(.microLabel)
						.monospacedDigit()
						.foregroundStyle(MaskinColor.badgeFg)
						.padding(.horizontal, MaskinSpace.s3 - 1)
						.frame(minWidth: MaskinSpace.s10, minHeight: MaskinSpace.s10)
						.background(MaskinGradient.badgeSolid, in: Capsule())
						.accessibilityLabel("\(type.needsYou) need you")
				}
				Text(type.countLabel)
					.maskinText(.caption)
					.monospacedDigit()
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.leading, MaskinSpace.s7)
			.padding(.trailing, MaskinSpace.s5)
			.frame(height: MaskinSpace.touchMin)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay {
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(active ? MaskinSurface.inverse : Color.clear, lineWidth: 1.5)
			}
			.contentShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("\(type.label), \(type.countLabel)")
		.accessibilityAddTraits(active ? [.isSelected] : [])
	}

	private func savedRow(_ view: SavedView, count: Int) -> some View {
		let scope = ObjectsScope.saved(view.id)
		let active = current == scope
		return Button {
			onSelect(scope)
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: "bookmark")
					.maskinSymbol(MaskinFontSize.t16, weight: .regular)
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s11)
				Text(view.name)
					.maskinText(.body)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				Spacer(minLength: 0)
				Text("\(count)")
					.maskinText(.subhead)
					.monospacedDigit()
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.s12 * 2)
			.background(active ? MaskinSurface.fill : Color.clear)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.contextMenu {
			if let onRemoveSavedView {
				Button(role: .destructive) {
					onRemoveSavedView(view.id)
				} label: {
					Label("Remove view", systemImage: "bookmark.slash")
				}
			}
		}
		.accessibilityLabel("\(view.name), saved view, \(count)")
		.accessibilityAddTraits(active ? [.isSelected] : [])
	}
}

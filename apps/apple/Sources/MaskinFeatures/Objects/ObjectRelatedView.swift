import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Related page: links grouped by what they mean ("Waiting on", "Belongs to"…) with the object's
/// flow first, one card per group, and "Link an object" at the end. A row carries the other
/// object's type glyph, its real title on up to two lines, its status and a chevron.
struct ObjectRelatedView: View {
	let store: ObjectDetailStore
	var onOpenObject: ((String) -> Void)?
	@State private var linking = false

	/// A flow row gets the Flows glyph; everything else its type's.
	static func glyph(for type: String) -> String {
		type == RelatedGrouping.flowType ? "arrow.triangle.2.circlepath" : MaskinObjectType.glyph(for: type)
	}

	var body: some View {
		let groups = store.relatedGroups
		VStack(alignment: .leading, spacing: 0) {
			if groups.isEmpty {
				if store.hasFetched {
					EmptyState(
						symbol: "link", title: "Nothing related yet",
						message: "Nothing is linked to this yet. Use Link an object below to connect one.")
				} else {
					LoadingSkeleton(rows: 2)
				}
			}
			ForEach(groups) { group in
				RelatedGroupSection(group: group, store: store, onOpenObject: onOpenObject)
			}
			Button {
				linking = true
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					Image(systemName: "plus").maskinSymbol(MaskinFontSize.t15, weight: .semibold)
					Text("Link an object").font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .body))
					Spacer(minLength: 0)
				}
				.foregroundStyle(MaskinColor.ink4)
				.padding(.horizontal, MaskinSpace.s8)
				.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s2)
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
						.strokeBorder(MaskinColor.ruleStrong, style: StrokeStyle(lineWidth: 1, dash: [MaskinSpace.s3, MaskinSpace.s2]))
				)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.padding(.top, MaskinSpace.s8)
		}
		.sheet(isPresented: $linking) {
			LinkObjectSheet(search: { await store.searchObjects($0) }) { ref in
				Task { await store.linkObject(ref) }
			}
		}
	}
}

/// One group of links: its heading with a count, then a card of rows. A long group shows its
/// first few, with "Show all N" to open the rest.
struct RelatedGroupSection: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let group: RelatedGroup
	let store: ObjectDetailStore
	var onOpenObject: ((String) -> Void)?
	@State private var showAll = false

	private static var preview: Int { 5 }

	var body: some View {
		let links = showAll ? group.links : Array(group.links.prefix(Self.preview))
		HStack(spacing: MaskinSpace.s2) {
			Text(group.label)
			Text("\(group.links.count)").monospacedDigit()
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
		.foregroundStyle(MaskinColor.ink5)
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.top, MaskinSpace.s8)
		.padding(.bottom, MaskinSpace.s4)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
		VStack(spacing: 0) {
			ForEach(Array(links.enumerated()), id: \.element.id) { index, link in
				RelatedRow(
					glyph: ObjectRelatedView.glyph(for: link.otherType), title: store.title(for: link),
					status: link.otherStatus, showsSeparator: index > 0,
					pending: link.id.hasPrefix("local-"),
					open: onOpenObject.map { open in { open(link.otherId) } })
			}
			if group.links.count > Self.preview {
				Button(showAll ? "Show fewer" : "Show all \(group.links.count)") {
					withAnimation(reduceMotion ? nil : MaskinMotion.standard) { showAll.toggle() }
				}
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
				.padding(.horizontal, MaskinSpace.s8)
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
	}
}

/// One related object: 32pt neutral glyph tile, title on two lines, status word, chevron.
struct RelatedRow: View {
	let glyph: String
	let title: String
	let status: String?
	var showsSeparator = false
	/// Linked here and still on its way to the server; drawn a touch quieter.
	var pending = false
	var open: (() -> Void)?

	private static var tile: CGFloat { MaskinSpace.s14 }

	var body: some View {
		let label = HStack(spacing: MaskinSpace.s7) {
			Image(systemName: glyph)
				.maskinSymbol(MaskinFontSize.t17, weight: .medium)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: Self.tile, height: Self.tile)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous))
				.accessibilityHidden(true)
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.multilineTextAlignment(.leading)
				.frame(maxWidth: .infinity, alignment: .leading)
			if let status {
				Text(MaskinStatus.sentenceLabel(for: status))
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
					.lineLimit(1)
					.frame(maxWidth: MaskinSpace.s14 * 3, alignment: .trailing)
			}
			if open != nil {
				Image(systemName: "chevron.right")
					.maskinSymbol(MaskinFontSize.t12, weight: .bold)
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s4)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s7)
		.opacity(pending ? 0.6 : 1)
		.overlay(alignment: .top) {
			if showsSeparator {
				Rectangle().fill(MaskinSurface.separator).frame(height: 1)
					.padding(.leading, MaskinSpace.s8 + Self.tile + MaskinSpace.s7)
			}
		}
		.contentShape(Rectangle())
		Group {
			if let open {
				Button(action: open) { label }.buttonStyle(.maskinPressed)
			} else {
				label
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(status.map { "\(title), \(MaskinStatus.label(for: $0))" } ?? title)
	}
}

/// Search the workspace and pick an object to link. The same search the `/` picker uses.
struct LinkObjectSheet: View {
	let search: (String) async -> [CommentReference]
	let pick: (CommentReference) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var query = ""
	@State private var results: [CommentReference] = []
	@State private var searching = false

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					if results.isEmpty, !searching, !query.isEmpty {
						Text("No object by that name").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							.padding(MaskinSpace.s8)
					}
					VStack(spacing: 0) {
						ForEach(Array(results.enumerated()), id: \.element.id) { index, ref in
							RelatedRow(
								glyph: MaskinObjectType.glyph(for: ref.type), title: ref.title, status: nil,
								showsSeparator: index > 0,
								open: {
									MaskinHaptics.play(.selection)
									pick(ref)
									dismiss()
								})
						}
					}
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s5)
			}
			.background(MaskinSurface.grouped)
			.searchable(text: $query, prompt: "Search objects")
			.task(id: query) {
				searching = true
				try? await Task.sleep(for: .milliseconds(200))
				guard !Task.isCancelled else { return }
				let found = await search(query)
				guard !Task.isCancelled else { return }
				results = found
				searching = false
			}
			.navigationTitle("Link an object")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
		}
		.presentationDetents([.medium, .large])
	}
}

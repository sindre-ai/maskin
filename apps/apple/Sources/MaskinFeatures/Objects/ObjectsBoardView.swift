import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Objects board: one type's objects in a horizontal run of status columns, each a stack of
/// compact cards (type dot, title, driver). Cards open like list rows do.
struct ObjectsBoardView: View {
	@Bindable var store: ObjectsStore
	@Bindable var board: ObjectsBoardStore
	/// Set in a split view, where a card drives the selection instead of pushing.
	let selection: Binding<String?>?
	var zoomNamespace: Namespace.ID?

	/// Wide enough for a title over two lines, narrow enough that the next column peeks in.
	private static let columnWidth: CGFloat = 272

	var body: some View {
		Group {
			if store.typeFilter == nil {
				ScrollView {
					EmptyState(
						symbol: "rectangle.split.3x1", title: "Choose a type",
						message: "The board shows one type at a time. Pick one above.")
				}
			} else {
				content
			}
		}
		.task(id: BoardKey(type: store.typeFilter, sort: store.display.sort)) {
			await board.load(type: store.typeFilter, sort: store.display.sort)
		}
	}

	private struct BoardKey: Hashable {
		var type: String?
		var sort: ObjectsSort
	}

	@ViewBuilder private var content: some View {
		switch board.phase {
		case .idle, .loading:
			ScrollView { LoadingSkeleton().padding(MaskinSpace.s9) }
		case .failed(let message):
			ScrollView {
				VStack(spacing: MaskinSpace.s7) {
					OfflineBanner(isVisible: board.isOffline)
					EmptyState(
						symbol: "exclamationmark.triangle", title: "Couldn't load the board", message: message
					) {
						Button("Try again") { Task { await board.refresh() } }
							.buttonStyle(.secondaryAction)
					}
				}
				.padding(MaskinSpace.s9)
			}
		case .loaded:
			if board.columns.allSatisfy({ $0.total == 0 }) {
				ScrollView {
					EmptyState(
						symbol: "square.stack.3d.up", title: "Nothing here yet",
						message: "Insights, bets and tasks from you and your agents land here.")
				}
				.refreshable { await board.refresh() }
			} else {
				columns
			}
		}
	}

	private var columns: some View {
		let needsYouOnly = store.display.needsYouOnly
		return ScrollView {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(alignment: .top, spacing: MaskinSpace.s5) {
					ForEach(board.shownColumns) { column in
						columnView(column, needsYouOnly: needsYouOnly)
					}
				}
				.scrollTargetLayout()
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.bottom, MaskinSpace.s9)
			}
			.scrollTargetBehavior(.viewAligned)
		}
		.refreshable { await board.refresh() }
	}

	private func columnView(_ column: ObjectsBoardColumn, needsYouOnly: Bool) -> some View {
		let cards = board.cards(in: column, needsYouOnly: needsYouOnly)
		return VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s4) {
				Text(MaskinStatus.label(for: column.value).uppercased())
					.maskinText(.microLabelLarge)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: MaskinSpace.s3)
				Text("\(board.count(in: column, needsYouOnly: needsYouOnly))")
					.maskinText(.microLabelLarge)
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.horizontal, MaskinSpace.s3)
			.padding(.bottom, MaskinSpace.s2)
			.accessibilityElement(children: .combine)
			.accessibilityAddTraits(.isHeader)
			if cards.isEmpty {
				Text("Nothing here yet")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink5)
					.padding(.horizontal, MaskinSpace.s3)
					.padding(.vertical, MaskinSpace.s4)
			}
			ForEach(cards) { object in
				card(object)
			}
			if column.hasMore, !needsYouOnly {
				Button {
					Task { await board.loadMore(column: column.id) }
				} label: {
					Group {
						if board.loadingMore.contains(column.id) {
							ProgressView()
						} else {
							Text("Show more").maskinText(.subhead).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink3)
						}
					}
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.s14)
				}
				.buttonStyle(.maskinPressed)
			}
		}
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.top, MaskinSpace.s6)
		.padding(.bottom, MaskinSpace.s4)
		.frame(width: Self.columnWidth, alignment: .top)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous))
	}

	@ViewBuilder private func card(_ object: WorkObject) -> some View {
		let content = ObjectBoardCard(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			showsDriver: store.display.shows(.driver), showsUpdated: store.display.shows(.updated))
		if let selection {
			Button { selection.wrappedValue = object.id } label: { content }
				.buttonStyle(.maskinPressed(.shrink))
		} else {
			NavigationLink(value: ObjectRoute(id: object.id)) { content }
				.buttonStyle(.maskinPressed(.shrink))
				.zoomSource(id: object.id, in: zoomNamespace)
		}
	}
}

/// A board card: type dot over the title over the driver, with "Needs you" when it does.
struct ObjectBoardCard: View {
	let object: WorkObject
	let typeName: String
	let ownerName: String?
	var ownerIsAgent = false
	var showsDriver = true
	var showsUpdated = true

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s3) {
				RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
					.fill(MaskinObjectType.colors(for: object.type).fg)
					.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					.accessibilityHidden(true)
				Text(typeName)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: MaskinSpace.s3)
				if ObjectsUrgency.needsYou(object) {
					Text("Needs you")
						.maskinText(.caption).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.sigInk)
						.padding(.horizontal, MaskinSpace.s3)
						.padding(.vertical, MaskinSpace.s1)
						.background(MaskinColor.sigTint, in: Capsule())
						.fixedSize()
				}
			}
			Text(object.displayTitle)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(3)
				.multilineTextAlignment(.leading)
			if (showsDriver && ownerName != nil) || showsUpdated {
				HStack(spacing: MaskinSpace.s3) {
					if showsDriver, let ownerName {
						ObjectDriverAvatar(
							name: ownerName, isAgent: ownerIsAgent, seed: object.driverId,
							working: object.hasActiveSession)
						Text(ownerName)
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s3)
					if showsUpdated {
						RelativeTime(object.updatedAt, style: .compact)
							.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
				}
			}
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s6)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}
}

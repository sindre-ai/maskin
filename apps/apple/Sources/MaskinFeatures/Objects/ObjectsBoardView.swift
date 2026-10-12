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
	/// Called after a card moved column, with the toast text and the way back.
	var offerUndo: (String, @escaping @MainActor () async -> Void) -> Void = { _, _ in }

	/// Handoff 1B: 300pt columns that snap sideways, the next one peeking in on a phone.
	private static let columnWidth: CGFloat = 300

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
				Group {
					if board.isOffline {
						AmberNotice.offline(since: store.freshness.updatedAt) { Task { await board.refresh() } }
					} else {
						AmberNotice(
							title: "Couldn't load the board", message: message, actionTitle: "Retry"
						) { Task { await board.refresh() } }
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
			if let error = board.moveError {
				FormError(error)
					.onTapGesture { board.clearMoveError() }
					.padding(.horizontal, MaskinSpace.s9)
			}
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
				if !column.value.isEmpty {
					StatusCategoryGlyph(category: StatusCategory.of(column.value))
				}
				Text(MaskinStatus.label(for: column.value))
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(1)
				Spacer(minLength: MaskinSpace.s3)
				Text("\(board.count(in: column, needsYouOnly: needsYouOnly))")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.horizontal, MaskinSpace.s3)
			.padding(.bottom, MaskinSpace.s2)
			.accessibilityElement(children: .combine)
			.accessibilityAddTraits(.isHeader)
			if cards.isEmpty {
				Text("No \(MaskinStatus.label(for: column.value).lowercased()) items")
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
		// A long-press drag of a card lands here and changes its status.
		.dropDestination(for: String.self) { ids, _ in
			guard let id = ids.first, !column.value.isEmpty else { return false }
			move(id, to: column.value)
			return true
		}
	}

	private func move(_ id: String, to status: String) {
		MaskinHaptics.play(.selection)
		Task {
			guard let change = await board.move(id, toColumn: status) else { return }
			offerUndo("Moved to \(MaskinStatus.label(for: status)). Undo.") {
				_ = await board.move(id, toColumn: change.from)
			}
		}
	}

	@ViewBuilder private func card(_ object: WorkObject) -> some View {
		let content = ObjectBoardCard(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			ask: store.asks[object.id], needsYou: store.needsYou(object),
			showsDriver: store.display.shows(.driver), showsUpdated: store.display.shows(.updated))
		Group {
			if let selection {
				Button { selection.wrappedValue = object.id } label: { content }
					.buttonStyle(.maskinPressed(.shrink))
			} else {
				NavigationLink(value: ObjectRoute(id: object.id)) { content }
					.buttonStyle(.maskinPressed(.shrink))
					.zoomSource(id: object.id, in: zoomNamespace)
			}
		}
		.draggable(object.id)
		// The same move without dragging, for VoiceOver and a steady hand.
		.contextMenu {
			Button {
				Task { await store.toggleStar(object.id) }
			} label: {
				Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.slash" : "star")
			}
			Menu("Move to", systemImage: "arrow.right") {
				ForEach(store.directory.schema.statuses(for: object.type).filter { $0 != object.status }, id: \.self) {
					status in
					Button(MaskinStatus.label(for: status)) { move(object.id, to: status) }
				}
			}
		}
	}
}

/// A board card (handoff 8): the same content as a list row (title, the ask while it needs the
/// person, driver, working bars, status and time) on a card. The column already says the status
/// and the board is one type, so neither the glyph nor the status word repeat.
struct ObjectBoardCard: View {
	let object: WorkObject
	let typeName: String
	let ownerName: String?
	var ownerIsAgent = false
	var ask: ObjectAsk?
	var needsYou = false
	var showsDriver = true
	var showsUpdated = true

	var body: some View {
		ObjectRow(
			object: object, typeName: typeName, ownerName: ownerName, ownerIsAgent: ownerIsAgent,
			ask: ask, needsYou: needsYou, showsTypeGlyph: false, showsStatus: false,
			showsDriver: showsDriver, showsUpdated: showsUpdated)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s7)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
			.contentShape(Rectangle())
	}
}

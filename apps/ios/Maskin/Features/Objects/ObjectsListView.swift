import SwiftUI

/// Objects — all objects in the workspace, filterable by type. Row-swipe Approve/Hold
/// and the bulk-select bar from the design prototype are Milestone-3 polish (native
/// gestures); v1 ships a plain filtered list wired to real data.
struct ObjectsListView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel
	@State private var typeFilter: String?

	private let types = ["insight", "bet", "task", "loop"]

	private var filtered: [MaskinObject] {
		guard let typeFilter else { return appModel.objects }
		return appModel.objects.filter { $0.type == typeFilter }
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				filterBar
				List {
					ForEach(filtered) { object in
						NavigationLink(value: object.id) {
							ObjectRow(object: object)
						}
					}
				}
				.listStyle(.plain)
			}
			.background(MaskinColor.surface)
			.navigationTitle("Objects")
			.navigationDestination(for: String.self) { objectId in
				ObjectDetailView(objectId: objectId)
			}
			.overlay {
				if filtered.isEmpty && !appModel.isLoadingObjects {
					ContentUnavailableView("No objects", systemImage: "cube")
				}
			}
			.refreshable {
				if let workspaceId = auth.workspaceId {
					await appModel.refreshObjects(workspaceId: workspaceId)
				}
			}
		}
	}

	private var filterBar: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpacing.s2) {
				filterChip("All", isSelected: typeFilter == nil) { typeFilter = nil }
				ForEach(types, id: \.self) { type in
					filterChip(type.capitalized, isSelected: typeFilter == type) { typeFilter = type }
				}
			}
			.padding(.horizontal, MaskinSpacing.s4)
			.padding(.vertical, MaskinSpacing.s2)
		}
	}

	private func filterChip(_ label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(label)
				.font(MaskinFont.sm.weight(.medium))
				.padding(.horizontal, MaskinSpacing.s3)
				.padding(.vertical, 6)
				.background(isSelected ? MaskinColor.ink : MaskinColor.linen)
				.foregroundStyle(isSelected ? MaskinColor.surface : MaskinColor.ink2)
				.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.chip))
		}
	}
}

private struct ObjectRow: View {
	let object: MaskinObject

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s1) {
			HStack {
				ObjectTypeTag(type: object.type)
				Spacer()
				StatusPill(text: object.status.replacingOccurrences(of: "_", with: " "))
			}
			Text(object.title ?? "Untitled")
				.font(MaskinFont.md.weight(.semibold))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
		}
		.padding(.vertical, MaskinSpacing.s1)
	}
}

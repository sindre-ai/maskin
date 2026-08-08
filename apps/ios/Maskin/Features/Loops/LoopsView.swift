import SwiftUI

/// Loops — `GET /api/loops` is list-only (see plan Context: no detail endpoint exists
/// yet), so tapping a row opens the loop's own object detail rather than a purpose-built
/// loop screen.
struct LoopsView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel

	var body: some View {
		NavigationStack {
			List {
				ForEach(appModel.loops) { loop in
					NavigationLink(value: loop.id) {
						LoopRow(loop: loop)
					}
				}
			}
			.listStyle(.plain)
			.background(MaskinColor.surface)
			.navigationTitle("Loops")
			.navigationDestination(for: String.self) { loopId in
				ObjectDetailView(objectId: loopId)
			}
			.overlay {
				if appModel.loops.isEmpty && !appModel.isLoadingLoops {
					ContentUnavailableView("No loops yet", systemImage: "arrow.triangle.2.circlepath")
				}
			}
			.refreshable {
				if let workspaceId = auth.workspaceId {
					await appModel.refreshLoops(workspaceId: workspaceId)
				}
			}
		}
	}
}

private struct LoopRow: View {
	let loop: LoopSummary

	private var pillLabel: String {
		switch loop.pill {
		case "waiting_on_you": return "Waiting on you"
		default: return loop.pill.capitalized
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s2) {
			HStack {
				Text(loop.name ?? "Untitled loop")
					.font(MaskinFont.md.weight(.semibold))
					.foregroundStyle(MaskinColor.ink)
				Spacer()
				StatusPill(text: pillLabel, accent: loop.pill == "waiting_on_you")
			}
			if let guarantee = loop.guarantee, !guarantee.isEmpty {
				Text(guarantee).font(MaskinFont.sm).foregroundStyle(MaskinColor.ink2).lineLimit(2)
			}
			HStack(spacing: MaskinSpacing.s3) {
				Label("\(loop.inProgressCount) in progress", systemImage: "circle.dotted")
				Label("\(loop.closedCount) closed", systemImage: "checkmark.circle")
			}
			.font(MaskinFont.mono(11))
			.foregroundStyle(MaskinColor.ink3)
		}
		.padding(.vertical, MaskinSpacing.s1)
	}
}

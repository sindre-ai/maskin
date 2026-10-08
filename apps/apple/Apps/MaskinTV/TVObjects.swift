import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Objects: type pills and a two-column grid of cards. Read only on TV; deciding goes through For
/// you, editing stays on the iPhone and iPad.
struct TVObjects: View {
	let environment: AppEnvironment
	@State private var store: ObjectsStore?

	private let columns = [GridItem(.flexible(), spacing: 40), GridItem(.flexible(), spacing: 40)]

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 32) {
					Text("Objects").font(.system(size: 64, weight: .bold))
					if let store {
						pills(store)
						grid(store)
					} else {
						ProgressView().frame(maxWidth: .infinity, minHeight: 300)
					}
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: WorkObject.self) { TVObjectDetail(object: $0, schema: store?.directory.schema) }
		}
		.task(id: environment.workspaceId) { await start() }
	}

	private func pills(_ store: ObjectsStore) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 16) {
				pill("All", selected: store.typeFilter == nil) { Task { await store.setType(nil) } }
				ForEach(store.presentTypes, id: \.self) { type in
					pill(store.directory.schema.displayName(for: type), selected: store.typeFilter == type) {
						Task { await store.setType(type) }
					}
				}
			}
			.padding(.vertical, 12)
		}
		.scrollClipDisabled()
	}

	private func pill(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title).font(.system(size: 28, weight: selected ? .bold : .regular))
				.padding(.horizontal, 32).frame(minHeight: 72)
				.background(selected ? MaskinSurface.fillStrong : Color.clear, in: Capsule())
		}
		.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 36))
	}

	@ViewBuilder private func grid(_ store: ObjectsStore) -> some View {
		if store.objects.isEmpty, store.phase == .loaded {
			EmptyState(symbol: "square.stack.3d.up", title: "Nothing here yet")
		} else if store.objects.isEmpty {
			ProgressView().frame(maxWidth: .infinity, minHeight: 300)
		} else {
			LazyVGrid(columns: columns, spacing: 40) {
				ForEach(store.visibleObjects) { object in
					NavigationLink(value: object) { TVObjectCard(object: object, schema: store.directory.schema) }
						.buttonStyle(TVFocusStyle())
				}
			}
			.padding(.vertical, 24)
		}
	}

	private func start() async {
		guard environment.auth.session != nil else {
			store = nil
			return
		}
		let remote = APIObjectsRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider)
		let auth = environment.auth
		let directory = ObjectsDirectory(remote: remote, workspaceId: { auth.session?.workspaceId })
		let next = ObjectsStore(remote: remote, directory: directory, cache: environment.snapshotCache)
		store = next
		await next.load()
	}
}

private struct TVObjectCard: View {
	let object: WorkObject
	let schema: ObjectsSchema

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			HStack(spacing: 12) {
				Circle().fill(MaskinColor.ink3).frame(width: 14, height: 14)
				Text(schema.displayName(for: object.type).uppercased())
					.font(.system(size: 22, weight: .semibold, design: .monospaced))
					.foregroundStyle(MaskinColor.ink4)
				Spacer(minLength: 0)
				if object.unreadCount > 0 {
					Text("NEEDS YOU")
						.font(.system(size: 20, weight: .semibold, design: .monospaced))
						.padding(.horizontal, 14).padding(.vertical, 6)
						.background(MaskinSurface.inverse, in: Capsule())
						.foregroundStyle(MaskinSurface.onInverse)
				}
			}
			Text(object.title ?? "Untitled").font(.system(size: 32, weight: .bold)).lineLimit(2)
			Text(object.status.replacingOccurrences(of: "_", with: " "))
				.font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
		}
		.padding(32)
		.frame(maxWidth: .infinity, minHeight: 200, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}
}

private struct TVObjectDetail: View {
	let object: WorkObject
	let schema: ObjectsSchema?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 32) {
				Text(((schema?.displayName(for: object.type)) ?? object.type).uppercased())
					.font(.system(size: 26, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				Text(object.title ?? "Untitled").font(.system(size: 64, weight: .bold))
				Text(object.status.replacingOccurrences(of: "_", with: " "))
					.font(.system(size: 32)).foregroundStyle(MaskinColor.ink3)
				if let content = object.content?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty {
					Text(content).font(.system(size: 30)).foregroundStyle(MaskinColor.ink3)
						.frame(maxWidth: 1200, alignment: .leading)
				}
				Button {} label: { TVCapsuleLabel(title: "Edit on iPhone or iPad", symbol: "iphone") }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					.frame(maxWidth: 640)
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}

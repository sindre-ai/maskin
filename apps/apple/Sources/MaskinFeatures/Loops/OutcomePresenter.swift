import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An outcome shown full screen: a page fills the sheet edge to edge and runs, anything else uses
/// the file viewer's content. "Change it" hands the request to chat, where an agent edits the file.
struct OutcomePresenter: View {
	let output: LoopOutput
	let sourceName: String
	@State private var store: FileStore
	@Environment(\.dismiss) private var dismiss
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	init(environment: AppEnvironment, output: LoopOutput, sourceName: String) {
		self.output = output
		self.sourceName = sourceName
		_store = State(
			initialValue: FileStore(
				fileId: output.id,
				remote: APIFilesRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider)))
	}

	var body: some View {
		NavigationStack {
			content
				.background(MaskinSurface.grouped)
				.navigationTitle(output.name)
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					ToolbarItem(placement: .cancellationAction) {
						Button("Done") { dismiss() }
					}
					if let file = store.file {
						ToolbarItem(placement: .primaryAction) {
							ShareLink(item: FileExport(file: file), preview: SharePreview(file.name)) {
								Label("Share", systemImage: "square.and.arrow.up")
							}
						}
						ToolbarItem(placement: .primaryAction) {
							Button(action: changeIt) { Label("Change it", systemImage: "sparkles") }
						}
					}
				}
		}
		.task { await store.load() }
		.onDisappear { FileStore.clearExports() }
	}

	@ViewBuilder
	private var content: some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 6).padding(MaskinSpace.s9)
		case .failed(let message):
			EmptyState(
				symbol: store.isOffline ? "wifi.slash" : "exclamationmark.triangle",
				title: "Couldn't open this", message: message
			) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if let file = store.file {
				if file.kind == .html {
					PresentedHTMLView(html: store.text ?? file.text ?? "", revision: store.contentRevision)
						.ignoresSafeArea(edges: .bottom)
				} else {
					ScrollView {
						FileContentView(
							file: file, showsSource: false, text: store.text, revision: store.contentRevision
						)
						.padding(MaskinSpace.s9)
						.frame(maxWidth: 760, alignment: .leading)
						.frame(maxWidth: .infinity)
					}
				}
			}
		}
	}

	private func changeIt() {
		let text = "Change \"\(output.name)\" (from \"\(sourceName)\"): "
		dismiss()
		runtime?.buildInChat(text)
	}
}

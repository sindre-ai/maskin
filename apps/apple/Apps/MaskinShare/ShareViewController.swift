import MaskinCore
import MaskinDesign
import SwiftUI
import UIKit

/// Host for the share sheet: reads what the host app handed over, builds the model, and bridges
/// "close" and "open Maskin" to the extension context. All behaviour lives in MaskinCore.
final class ShareViewController: UIViewController {
	private var model: ShareSheetModel?

	override func viewDidLoad() {
		super.viewDidLoad()
		let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
		let sources = items.flatMap { $0.attachments ?? [] }.map(NSItemProviderSource.init)
		// Safari offers the page title as the item's title or content text.
		let title = items.lazy
			.compactMap { $0.attributedTitle?.string ?? $0.attributedContentText?.string }
			.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
		let context = ShareContext(title: title)
		let baseURL = Self.apiBaseURL

		let model = ShareSheetModel(
			secretStore: KeychainSecretStore(),
			loadContent: { await ShareExtractor().extract(from: sources, context: context) },
			makeRemote: { ShareSession.remote(baseURL: baseURL, credentials: $0) })
		self.model = model

		let host = UIHostingController(
			rootView: ShareSheetView(
				model: model, onClose: { [weak self] in self?.close() },
				onOpen: { [weak self] url in self?.open(url) }))
		addChild(host)
		host.view.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(host.view)
		NSLayoutConstraint.activate([
			host.view.topAnchor.constraint(equalTo: view.topAnchor),
			host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
			host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
		])
		host.didMove(toParent: self)
	}

	private static var apiBaseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}

	private func close() {
		model?.finish()
		extensionContext?.completeRequest(returningItems: nil)
	}

	/// An extension can't call `UIApplication.shared`, but the application sits on the responder
	/// chain and answers `open(_:options:completionHandler:)`. Best effort: the sheet closes either
	/// way, and the item is already saved, so a refusal costs one tap, not data.
	private func open(_ url: URL) {
		var responder: UIResponder? = self
		while let current = responder {
			if let application = current as? UIApplication {
				application.open(url, options: [:], completionHandler: nil)
				break
			}
			responder = current.next
		}
		close()
	}
}

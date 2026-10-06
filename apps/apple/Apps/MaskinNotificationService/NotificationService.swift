import UserNotifications

/// Makes a push richer than the one APNs delivered: decision buttons and an image.
///
/// iOS only lets an app register notification categories (the action button sets) AHEAD of time,
/// but a decision's buttons are the agent's own option labels and differ per notification. So the
/// server marks such pushes `mutable-content` with a compact `decision` object, and this extension
/// builds a category for THAT notification from its options, registers it, and points the
/// notification at it before iOS shows anything. The app handles the tap
/// (`PushAppDelegate`, which hands it to `NotificationActionHandler`).
///
/// It also attaches the push's `image_url` (https, size-capped, short timeout) so a banner can
/// show a picture. Grouping (`thread-id`), Focus behaviour (`interruption-level`) and the badge
/// come straight from `aps`; iOS applies them, nothing here needs to.
///
/// A push with neither a decision nor an image passes through untouched, and every failure path
/// (bad payload, failed download, the ~30 s budget running out) still delivers the notification
/// with whatever was ready: this extension must never swallow a push.
///
/// `PushDecision.swift` and `PushRichContent.swift` are compiled into this target directly
/// (project.yml), which keeps the extension to Foundation + UserNotifications and well inside its
/// memory limit.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
	private let lock = NSLock()
	private var contentHandler: ((UNNotificationContent) -> Void)?
	/// What gets delivered if time runs out: the original, improved step by step.
	private var bestAttempt: UNNotificationContent?
	private var session: URLSession?

	override func didReceive(
		_ request: UNNotificationRequest,
		withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
	) {
		lock.withLock {
			self.contentHandler = contentHandler
			bestAttempt = request.content
		}
		guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
			finish(request.content)
			return
		}
		let userInfo = content.userInfo
		let plan = PushDecisionPayload(userInfo: userInfo).map(NotificationActionPlan.init)
		let imageURL = PushImage.url(from: userInfo)
		guard plan != nil || imageURL != nil else {
			finish(request.content)
			return
		}

		// The category is set synchronously, so a timeout still delivers the buttons' category
		// even if the image is late.
		if let plan { content.categoryIdentifier = plan.categoryIdentifier }
		lock.withLock { bestAttempt = content }

		// The closures below run on other queues but never overlap on `content`: the image
		// callback writes it before leaving the group, `finish` reads it after the group is empty.
		nonisolated(unsafe) let shared = content

		// Work that can overlap: registering the buttons and downloading the picture.
		let group = DispatchGroup()
		if let plan {
			group.enter()
			registerCategory(for: plan) { group.leave() }
		}
		if let imageURL {
			group.enter()
			downloadAttachment(imageURL) { attachment in
				if let attachment {
					shared.attachments = [attachment]
				}
				group.leave()
			}
		}
		// Whatever finished is delivered; a step that failed just contributes nothing.
		group.notify(queue: .global()) { [weak self] in self?.finish(shared) }
	}

	/// About to be killed: deliver the best notification built so far (the buttons' category is
	/// already set; a half-downloaded image is simply left out) rather than lose the push.
	override func serviceExtensionTimeWillExpire() {
		let (content, session) = lock.withLock { (bestAttempt, self.session) }
		session?.invalidateAndCancel()
		if let content { finish(content) }
	}

	/// Delivers once; a later call (a timeout racing normal completion) is ignored.
	private func finish(_ content: UNNotificationContent) {
		let handler = lock.withLock {
			let handler = contentHandler
			contentHandler = nil
			return handler
		}
		handler?(content)
	}

	private func registerCategory(
		for plan: NotificationActionPlan, done: @escaping @Sendable () -> Void
	) {
		let category = Self.category(for: plan)
		let center = UNUserNotificationCenter.current()
		center.getDeliveredNotifications { delivered in
			center.getNotificationCategories { existing in
				// `setNotificationCategories` REPLACES the whole set, so merge: keep every fixed
				// category the app registered, and only the dynamic ones whose notification is
				// still on screen (an old one's buttons are useless once it is gone).
				let live = Set(delivered.map(\.request.content.categoryIdentifier))
				var merged = existing.filter {
					!$0.identifier.hasPrefix(PushDecisionPayload.categoryPrefix) || live.contains($0.identifier)
				}
				merged.remove(category)
				merged.insert(category)
				center.setNotificationCategories(merged)
				// Read the set back: that round trip is what guarantees the registration landed
				// before iOS renders the notification and looks its category up.
				center.getNotificationCategories { _ in done() }
			}
		}
	}

	/// Downloads the image to a temp file iOS can take ownership of. Every failure is `nil`.
	private func downloadAttachment(
		_ url: URL, completion: @escaping @Sendable (UNNotificationAttachment?) -> Void
	) {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = PushImage.timeout
		configuration.timeoutIntervalForResource = PushImage.timeout * 2
		let session = URLSession(configuration: configuration)
		lock.withLock { self.session = session }
		session.downloadTask(with: url) { location, response, _ in
			defer { session.finishTasksAndInvalidate() }
			guard let location, let http = response as? HTTPURLResponse, http.statusCode == 200,
				let ext = PushImage.fileExtension(
					forMIMEType: http.value(forHTTPHeaderField: "Content-Type")),
				let size = (try? FileManager.default.attributesOfItem(atPath: location.path))?[.size]
					as? Int64,
				PushImage.isWithinBudget(size)
			else { return completion(nil) }
			// The system moves an attachment's file, and it must carry the right extension.
			let target = FileManager.default.temporaryDirectory
				.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
			do {
				try FileManager.default.moveItem(at: location, to: target)
				completion(try UNNotificationAttachment(identifier: "image", url: target))
			} catch {
				completion(nil)
			}
		}.resume()
	}

	static func category(for plan: NotificationActionPlan) -> UNNotificationCategory {
		let actions: [UNNotificationAction] = plan.actions.map { action in
			var options: UNNotificationActionOptions = []
			if action.requiresAuthentication { options.insert(.authenticationRequired) }
			if action.isDestructive { options.insert(.destructive) }
			switch action.kind {
			case .option:
				return UNNotificationAction(identifier: action.identifier, title: action.title, options: options)
			case .reply:
				return UNTextInputNotificationAction(
					identifier: action.identifier, title: action.title, options: options,
					icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
					textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
			case .open:
				// The only action that opens the app; options and Reply run in the background.
				options.insert(.foreground)
				return UNNotificationAction(
					identifier: action.identifier, title: action.title, options: options,
					icon: UNNotificationActionIcon(systemImageName: "arrow.up.forward.app"))
			}
		}
		return UNNotificationCategory(
			identifier: plan.categoryIdentifier, actions: actions, intentIdentifiers: [],
			hiddenPreviewsBodyPlaceholder: "Maskin needs a decision", options: [])
	}
}

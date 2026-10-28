import SwiftUI

/// Where an actor's uploaded picture is served. `MainShell` provides it from the workspace's actor
/// list; without a shell (previews, tests) no actor has a picture and `ActorAvatar` draws initials.
public struct ActorPictures: Sendable {
	/// The picture's address for an actor id, or nil when the actor has none.
	public var url: @MainActor @Sendable (String) -> URL?

	public init(url: @escaping @MainActor @Sendable (String) -> URL?) {
		self.url = url
	}

	public static let none = ActorPictures { _ in nil }
}

private struct ActorPicturesKey: EnvironmentKey {
	static let defaultValue = ActorPictures.none
}

extension EnvironmentValues {
	public var actorPictures: ActorPictures {
		get { self[ActorPicturesKey.self] }
		set { self[ActorPicturesKey.self] = newValue }
	}
}

import MaskinAPI
import MaskinCore
import SwiftUI

/// Navigation value for "open this object".
struct ObjectRoute: Hashable {
	var id: String
}

/// The Objects slice's long-lived dependencies, built once per screen from `AppEnvironment`.
@MainActor
struct ObjectsServices {
	let environment: AppEnvironment
	let remote: any ObjectsRemote
	let directory: ObjectsDirectory

	init(environment: AppEnvironment) {
		self.environment = environment
		let remote = APIObjectsRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider)
		self.remote = remote
		let auth = environment.auth
		directory = ObjectsDirectory(remote: remote, workspaceId: { auth.session?.workspaceId })
	}

	func detailStore(for id: String, preload: WorkObject? = nil) -> ObjectDetailStore {
		ObjectDetailStore(
			objectId: id, remote: remote, directory: directory,
			currentActorId: environment.auth.session?.actorId, preload: preload)
	}
}

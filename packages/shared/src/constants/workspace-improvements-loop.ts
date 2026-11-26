// Canonical metadata for the Workspace improvements marketplace flow.
//
// The bundle ships no agent. Its triggers and skills name the workspace's own
// Workspace Coach and Chief of Staff by role, and install binds them to the agents every
// workspace already has (see services/loop-provisioning.ts, resolveRoleActors). Trigger and skill
// IDs are derived per role via `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

/** A role id stands in for an actor id in a bundle: install swaps it for the workspace's own agent. */
export const ROLE_ACTOR_PREFIX = 'role:'

export const WORKSPACE_IMPROVEMENTS_ROLE_COACH = 'role:workspace-coach'
export const WORKSPACE_IMPROVEMENTS_ROLE_CHIEF_OF_STAFF = 'role:chief-of-staff'

export const WORKSPACE_IMPROVEMENTS_LOOP_SLUG = 'workspace-improvements-loop'
export const WORKSPACE_IMPROVEMENTS_LOOP_NAME = 'Workspace improvements'
export const WORKSPACE_IMPROVEMENTS_LOOP_VERSION = '1.0.0'
export const WORKSPACE_IMPROVEMENTS_LOOP_USE_CASE = 'Operations'
export const WORKSPACE_IMPROVEMENTS_LOOP_DESCRIPTION =
	"Turns the Workspace Coach's findings into clear recommendations. Three times a week the Coach sweeps your agents, flows, triggers and feedback, files improvement insights and clusters them by theme into one recommendation with a concrete fix. It then records what was applied or rejected, so later coaching learns from it. Every day the Chief of Staff checks the flow against its two targets, chases what is stuck, and every Monday refreshes a Results tab that brings forward only what deserves a person. Runs on the Workspace Coach and Chief of Staff your workspace already has."

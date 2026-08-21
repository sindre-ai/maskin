import { smokeGlobalTeardown } from './helpers/smoke-cleanup'

export default async function globalTeardown() {
	await smokeGlobalTeardown()
}

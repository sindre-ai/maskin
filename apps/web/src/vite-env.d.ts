/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_POSTHOG_KEY?: string
	readonly VITE_POSTHOG_HOST?: string
	readonly VITE_SOC2_OBSERVATION_UNDERWAY?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

# Required Secrets for Quota Poller Workflow

These secrets must be configured in the GitHub repository settings
(`Settings → Secrets and variables → Actions`) for the quota poller
workflow to function correctly.

## Required

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_ADMIN_API_KEY` | Anthropic Admin API key with `organizations:usage_report` read scope. Used to poll Claude weekly + 5h rolling ceiling quotas via the Admin API `/v1/organizations/usage_report`. |
| `OPENROUTER_API_KEY` | OpenRouter API key. Used to poll daily credit consumption via `/api/v1/credits`. |

## Required by downstream tasks

| Secret | Description |
|--------|-------------|
| `SLACK_QUOTA_WEBHOOK_URL` | Slack Incoming Webhook URL for posting quota threshold alerts to `#ops-alerts`. Used by the Slack alert module (T2). |
| `POSTHOG_API_KEY` | PostHog API key for emitting `quota_alert_fired` events. Used by the PostHog capture module (T3). |

## Optional

| Secret | Description | Default |
|--------|-------------|---------|
| `ANTHROPIC_WEEKLY_CEILING` | Anthropic weekly ceiling in USD. | `1000` |
| `ANTHROPIC_5H_CEILING` | Anthropic 5-hour rolling ceiling in USD. | `150` |
| `THRESHOLD_PCT` | Alert threshold percentage. When any quota's `headroom_pct` exceeds this value, the poller logs a warning. | `80` |

All optional secrets fall back to sensible defaults in the poller script if not set.

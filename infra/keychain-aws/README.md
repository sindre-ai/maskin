# Keychain AWS substrate: runbook

Owner: Infra & DevOps. Decision record: ADR-010 (Keychain AWS bootstrap runs in GitHub Actions via OIDC, no AWS keys in any agent session). Task: Ops track, AWS KMS, Object Lock buckets, runtime IAM identity and CloudTrail.

Status: **drafted, never run.** Nothing here has touched AWS. The first staging preflight and bootstrap runs are the test.

## What is in this folder and in `.github/workflows`

| File | What it does |
| --- | --- |
| `human-bootstrap.cfn.yaml` | The human-only bundle: OIDC provider, runtime boundary, bootstrap role (one stack per environment). |
| `runtime-user-policy.json.tpl` | Inline policy the bootstrap workflow writes on the runtime user. Same statements as the runtime boundary. |
| `keychain-aws-preflight.yml` | Prints the OIDC `sub`, assumes the role, proves the other environment's role refuses. Changes nothing. |
| `keychain-aws-bootstrap.yml` | One environment: smoke KMS key, CloudTrail with its own bucket, runtime user with boundary. Staging also gets the Governance bucket and the delete-refused test. |
| `keychain-aws-production-bucket.yml` | Production Compliance bucket, 24 months. Own workflow, own approval, created last, gated. |
| `keychain-aws-rotate-key.yml` | Creates the runtime access key (first key too), verifies it, writes it to Coolify, redeploys, deletes the old key last. |

No workflow takes free-form input. Targets are a fixed choice. Bucket names are derived in the file: `maskin-keychain-worm-<env>-<account id>` and `maskin-keychain-trail-<env>-<account id>`. Region is eu-central-1 everywhere. Every job: `id-token: write`, `contents: read`. The production bucket workflow's gate job also has `actions: read` (it reads run history), nothing else.

## The one human item (the CTO sends it, once)

1. A **dedicated AWS member account** holding only Keychain resources (CTO decision 2026-10-03). A shared account goes back to the CTO.
2. In that account, region eu-central-1, deploy `human-bootstrap.cfn.yaml` twice with `CAPABILITY_NAMED_IAM`: `Target=staging, CreateOidcProvider=true`, then `Target=production, CreateOidcProvider=false`.
3. A break-glass administrator role held by a human, outside the template.
4. Two GitHub Environments in sindre-ai/maskin, named exactly `keychain-aws-staging` and `keychain-aws-production`: required reviewer is a human, prevent self-review on, deployment branches limited to `main`. Each gets the secret `AWS_ACCOUNT_ID`. Production also gets the secret `COOLIFY_TOKEN` (abilities read, write, deploy; not root, not read:sensitive) and the variable `HEALTH_URL` (a public URL that answers 200 only when the app is up).
5. Repo settings: a `CODEOWNERS` line for `/.github/workflows/` naming the human reviewer(s), and a ruleset that requires code-owner review and that agents cannot bypass. None of this exists or is verified today, and no agent can read repo settings.
6. Sentry: Settings, Security & Privacy, Advanced Data Scrubbing for the production projects: add `credentials`, `dek_ciphertext`, `dekCiphertext`, `rawSecret` as additional sensitive fields. The Sentry tools available to agents cannot change project scrubbing settings.
7. Click Run workflow and Approve for each run below. No agent has a workflow dispatch tool.

## Run order

1. `keychain-aws-preflight` staging. Expect: sub matches, role assumed, production role refuses. If the sub differs, fix the trust policy to the printed value.
2. `keychain-aws-bootstrap` staging. This is the first real test, see the unknowns below.
3. `keychain-aws-rotate-key` staging: **stops by design** until a Coolify target exists for staging (open question). Use it only after that is answered.
4. `keychain-aws-preflight` production, then `keychain-aws-bootstrap` production.
5. `keychain-aws-rotate-key` production: creates the first runtime key, writes it, redeploys, verifies.
6. Last: `keychain-aws-production-bucket`. Only after the CTO confirmed the bucket name and region. Cannot be undone, even by root.

Also run once from a non-main branch: it must be refused before any secret or token is issued.

## What the first staging run settles (unverified on paper)

- Whether `kms:CreateKey` with the tag in the create call passes with the deny on `TagResource` in place, then `CreateAlias`. The run summary says which shape held. If refused, the fallback in the Architect's policy draft section 2 needs a CTO decision, not an edit by me.
- Whether `iam:CreateUser` with a permissions boundary also needs `iam:PutUserPermissionsBoundary` (the policy denies it today).
- The `sub` claim format for this repository.
- Whether CloudTrail accepts the bucket policy as written and `create-trail` needs nothing beyond the listed actions.

## What each run proves

- Bootstrap: CreateKey without the tag is refused, CreateKey in eu-west-1 is refused, CreateUser without the boundary is refused. If any of these succeed the run fails loudly, and a stray key or user exists. The role cannot delete either, so the break-glass admin cleans up.
- Staging lock test: the role can call DeleteObject (a delete marker is written, proving delete permission), and deleting the locked version is refused with the text "protected by object lock". A plain permission error fails the test.
- Rotate: the new key, used as the runtime identity, does a KMS encrypt and decrypt round trip on the smoke key and is denied `iam:ListUsers` (boundary holds).

Not covered, run by a human once with a throwaway untagged key: PutKeyPolicy and CreateAlias on an untagged key are refused; TagResource on an untagged key is refused.

## Rotation

Every 90 days, per environment. Order is fixed: create, verify, write to Coolify, redeploy and wait healthy, delete old.

- Fails closed if the user already holds 2 keys.
- Fails before creating anything if the Coolify target, token or `HEALTH_URL` is missing.
- Failure before the Coolify write: the new key is removed, nothing changed.
- Failure after the Coolify write (deploy failed or not healthy): **both keys stay and the old key is not deleted.** Next run refuses (2 keys). A human fixes the deploy, then deletes whichever key the app does not use, by hand, in IAM.
- It writes only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `AWS_REGION=eu-central-1` and `KEYCHAIN_KMS=aws-kms` are set deliberately by a person when PR #1 is ready, never by a rotation.
- Coolify variables are written with is_shown_once (value hidden in UI and API). Coolify's API cannot set "runtime only", so the two variables are also available at build time like the other variables on that application. Untick Available at Buildtime in the Coolify dashboard once.

## Secrets handling in the workflows

The repo is public, so run logs are public. Values are masked on the first line after they are read. No `set -x`. Credentials never become step outputs, artifacts or command arguments: the Coolify token goes to curl through a header file descriptor, the key bodies are built by jq from environment variables and sent on stdin, and the Coolify reply (it echoes env values) goes to /dev/null with only the HTTP code printed. Bucket names carry the account id, so they print as `***`. The job summary holds yes or no lines only.

## Residual risks and open points

- The bootstrap role's CreateUser, PutUserPolicy and CreateAccessKey rights are an escalation path. The runtime boundary is what contains them, and the human reviewer reading the workflow diff at approval time is the control that matters.
- One account holds staging and production. S3, CloudTrail and IAM are separated by name per environment. **KMS is not:** both runtime users may use any key aliased `alias/maskin-keychain-*`. Separating KMS needs an environment segment in the alias that PR #1's KmsProvider would have to use. Decision for the Architect and CTO.
- `PutKeyPolicy` stays in the bootstrap policy as drafted, but no workflow uses it. Dropping it is a free tightening.
- Compliance retention is set as the bucket default. The production bucket policy denies `s3:PutBucketObjectLockConfiguration` to everyone, so only root or the break-glass admin editing the policy first can change it, and Compliance protects existing object versions regardless.
- Cost: each key $1 a month plus requests, CloudTrail management events for the first trail per region are free, S3 storage for 24 months of snapshots is small. The staging smoke objects expire after 1 day. The staging Governance bucket and the trail buckets keep small objects.
- Open: which Coolify resource consumes the staging runtime key. Until answered, staging rotation stops before creating a key.
- Action pins: `aws-actions/configure-aws-credentials` at v5.1.1 and `actions/checkout` v4, both by full commit SHA. Not checked against newer releases.
- Coolify API shape (bulk env PATCH, POST /deploy, deployment status) was read from Coolify's published OpenAPI, not tested against our version. Also unverified: whether a variable written with is_shown_once can be overwritten by the next rotation. If not, the run fails closed and removes the new key.

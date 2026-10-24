# Deployment — Accessibility Companion (hosted hackathon demo)

Status: **IMAGE BUILT AND VERIFIED — NOT DEPLOYED.** The release image was built by
Cloud Build and verified inside Cloud Build (see `deploy/build-evidence.json`).
**No Cloud Run service exists yet.** Deployment waits for the orchestrator's deploy
gate approval. Everything below describes real provisioned state, observed build
results, or prepared-but-not-run steps. Nothing here is a guarantee of pricing or limits.

- Project: `project-f788c2f2-5518-4c6d-847` (number `672419407385`)
- Region: `asia-south1` (user-approved)
- Public hosted demo, no auth. **Not production.** Target allowlist enforced by
  the app: only the deployed public fixture + `www.india.gov.in`, `india.gov.in`.

## 1. Provisioned prerequisite resources (verified real)

| Resource | Name / ID | Scope / flags |
| --- | --- | --- |
| APIs enabled | `run.googleapis.com`, `artifactregistry.googleapis.com`, `cloudbuild.googleapis.com`, `iam.googleapis.com` (storage/logging pre-existing) | project |
| Artifact Registry | `ac-demo` (docker, asia-south1) | image path `asia-south1-docker.pkg.dev/project-f788c2f2-5518-4c6d-847/ac-demo/api`, tags `$BUILD_ID` + `latest` |
| GCS bucket (scan reports) | `gs://ac-runs-672419407385` | asia-south1, **public access prevention enforced**, uniform bucket-level access; lifecycle delete at age **1 day**; object **soft delete disabled (0s)** — demo reports are user-approved temporary data |
| GCS bucket (Cloud Build source) | `gs://ac-src-672419407385` | asia-south1, private, uniform access; lifecycle delete **7 days** (cost control) |
| Service account (runtime) | `ac-demo-runtime@project-f788c2f2-5518-4c6d-847.iam.gserviceaccount.com` | **no project-level roles**; only `roles/storage.objectCreator` + `roles/storage.objectViewer` on `gs://ac-runs-672419407385` (the broader `roles/storage.objectUser` was **removed after the narrow grants were verified**) |
| Service account (build) | `ac-demo-build@project-f788c2f2-5518-4c6d-847.iam.gserviceaccount.com` | `roles/logging.logWriter` (project, minimal), `roles/artifactregistry.writer` (ac-demo repo), `roles/storage.objectUser` (source bucket) |
| actAs grants | the project's `roles/owner` user identity (personal email intentionally not recorded in committed files) | `roles/iam.serviceAccountUser` on both SAs — needed to trigger builds / deploy with the SA |

No IAM bindings were changed during the image build step.

Notes on the runtime role choice: report objects are immutable, so no
delete/update rights exist for the runtime SA. `objectViewer` unavoidably
includes object **listing** — the backend must not call any list API. A fully
minimal custom get/create-only role was deliberately NOT created (no scope creep;
predefined roles used instead). `storage.objectUser` remains only for the **build
SA on the source bucket** (it needs upload; objects there are throwaway staging
artifacts, deleted by lifecycle at 7 days).

Deletion honesty: GCS lifecycle deletion is **eventual**, not instant, and
never a guarantee of immediate hard delete. The **application** must enforce
the 24-hour report expiration itself (API rejects/expires runs past 24h).
Soft delete on the reports bucket was disabled so lifecycle-deleted objects do
not stay retrievable for an extra week.

Hard rules honored: runtime SA has no project roles; the default Cloud Run /
compute service accounts were not overridden or granted anything; the report
bucket must **never** become public. Global gcloud config was never changed —
all commands ran with explicit `--project`/`--region` (the local gcloud has a
personal global account configured; it was not modified).

Resource reference list: `deploy/resources.json` (names/IDs only; no tokens,
no personal identities).

## 2. Files (ownership)

- `Dockerfile` — multi-stage: official Node 24 overlay onto the **pinned** exact
  Playwright image `mcr.microsoft.com/playwright:v1.64.1-noble`; build (root `npm ci`
  + TS build; web `npm ci` + vite build) → runtime (root `npm ci --omit=dev`,
  `dist` + `web/dist` + public `test/fixtures`, non-root `app` user uid 10001,
  `PORT=8080`). Uses `RUN --mount=type=cache` (BuildKit).
- `.dockerignore` — **whitelist** build context (source only). Excludes
  `.agents/`, `.opencode/`, `opencode.json`, `skills-lock.json`, `logs/`,
  `.env*`, credentials, reports, personal files, `node_modules`, build dirs.
- `.gcloudignore` — same whitelist for the uploaded Cloud Build source. Its upload
  set was checked with the SDK's own ignore engine before the build (71 files,
  see `deploy/build-evidence.json`).
- `deploy/cloudbuild.yaml` — image build+push only, `CLOUD_LOGGING_ONLY`,
  `DOCKER_BUILDKIT=1`, 3600s timeout. Tags via **`$BUILD_ID` + `latest`**
  (manual builds from a non-Git checkout have an EMPTY `$SHORT_SHA` — never use
  it). **No deploy step.**
- `deploy/verify-image.cloudbuild.yaml` — post-build check run inside Cloud Build
  against a digest-pinned image: Node major, Playwright CLI version, uid, shipped
  file tree, and a real Chromium launch with the scanner's flags. Deploys nothing.
- `deploy/runtime-service.yaml` — Cloud Run spec pinned to the built image
  **digest** (see §4). First deploy **omits** the two self-URL env vars.
- `deploy/resources.json` — manifest of what exists, what was built, and what is planned.
- `deploy/build-evidence.json` — observed facts from the build and verification runs.

## 3. Image build — DONE

### 3.1 Base image pin (verified)

- `ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble`.
- Root `package-lock.json` resolves `node_modules/playwright` and `playwright-core`
  to **1.64.1**, so the pin matches exactly. Check:
  `node -p "require('./package-lock.json').packages['node_modules/playwright'].version"`.
- Node: the official `node:24-bookworm` binary is overlaid on the base image.
  Verified inside the built image: `node -v` → `v24.22.1`.

### 3.2 Local Docker — not used for this build

The local daemon is healthy, but repeated ~2GB local base-image pulls failed
earlier (MCR CDN resets) and destabilized the laptop. Real builds and checks run
in Cloud Build. Local runs, if ever needed, must bind to loopback only and are
never a public surface:

```bash
docker run --rm -p 127.0.0.1:8080:8080 <image>
```

### 3.3 Cloud Build — actual build (observed)

```bash
gcloud builds submit \
  --project=project-f788c2f2-5518-4c6d-847 \
  --region=asia-south1 \
  --default-buckets-behavior=REGIONAL_USER_OWNED_BUCKET \
  --gcs-source-staging-dir=gs://ac-src-672419407385/source \
  --service-account=projects/project-f788c2f2-5518-4c6d-847/serviceAccounts/ac-demo-build@project-f788c2f2-5518-4c6d-847.iam.gserviceaccount.com \
  --config=deploy/cloudbuild.yaml --quiet .
```

Result:

- Build ID `449e6043-73ca-43dd-ad3e-4cda812d3490`, status **SUCCESS**, duration 3M44S.
- Digest `sha256:45e235ffbc0e77fe434bb1f3e78c2caf2eeb70e0d3ce824cbc045cf1ae7d5fe0`
  (confirmed in Artifact Registry; tags `449e6043-…` and `latest` both point to it).
- Deploy reference (use this, not `latest`):
  `asia-south1-docker.pkg.dev/project-f788c2f2-5518-4c6d-847/ac-demo/api@sha256:45e235ffbc0e77fe434bb1f3e78c2caf2eeb70e0d3ce824cbc045cf1ae7d5fe0`
- Logs: `CLOUD_LOGGING_ONLY`. Read with
  `gcloud logging read 'resource.type="build" AND resource.labels.build_id="<BUILD_ID>"' --project=project-f788c2f2-5518-4c6d-847`.
  Log console link is in `deploy/build-evidence.json`.

### 3.4 Image verification — observed

```bash
gcloud builds submit --no-source \
  --project=project-f788c2f2-5518-4c6d-847 --region=asia-south1 \
  --service-account=projects/project-f788c2f2-5518-4c6d-847/serviceAccounts/ac-demo-build@project-f788c2f2-5518-4c6d-847.iam.gserviceaccount.com \
  --config=deploy/verify-image.cloudbuild.yaml \
  --substitutions=_IMAGE_REF=asia-south1-docker.pkg.dev/project-f788c2f2-5518-4c6d-847/ac-demo/api@sha256:45e235ffbc0e77fe434bb1f3e78c2caf2eeb70e0d3ce824cbc045cf1ae7d5fe0 \
  --quiet
```

Result: verification build `1ef83dde-e329-4d8c-9e53-e6d3626e0caa`, **SUCCESS**.
Observed values: `node v24.22.1`, `Playwright 1.64.1`, `uid 10001`, shipped-tree
check ok, Chromium `156.0.8078.4` launched with the scanner's flags.

## 4. Cloud Run deployment — BLOCKED until orchestrator deploy gate approval

Do **NOT** run these until the orchestrator approves the deploy gate. The
`runtime-service.yaml` image is already pinned to the verified digest.

```bash
gcloud run services replace deploy/runtime-service.yaml \
  --project=project-f788c2f2-5518-4c6d-847 --region=asia-south1
```

Immediately after the first revision exists, read the REAL URL and set the
self-URL vars (never a placeholder):

```bash
URL=$(gcloud run services describe ac-demo \
  --project=project-f788c2f2-5518-4c6d-847 --region=asia-south1 \
  --format='value(status.url)')
gcloud run services update ac-demo \
  --project=project-f788c2f2-5518-4c6d-847 --region=asia-south1 \
  --update-env-vars=ACCESSIBILITY_ALLOWED_ORIGINS=${URL},ACCESSIBILITY_PUBLIC_BASE_URL=${URL}
```

Settings in `deploy/runtime-service.yaml` and what each one does:

- `cpu: 1`, `memory: 2Gi`, `containerConcurrency: 8`, `maxScale: 1`, `minScale: 0`,
  `timeoutSeconds: 60`. The app's whole scan deadline is 45s
  (`ACCESSIBILITY_SCAN_TIMEOUT_MS=45000`). Concurrency stays **8** because the
  service fetches its own fixture URLs while a scan holds the scan lock. Raise CPU to
  `2` only if measured scans cannot finish within 45s.
- Ingress `all`, unauthenticated. Public demo, not production. `/mcp` is stateless
  Streamable HTTP with **no OAuth**.
- Env (see the file for comments): `NODE_ENV`, `PORT`,
  `ACCESSIBILITY_REPORT_BUCKET=ac-runs-672419407385`,
  `ACCESSIBILITY_ALLOWED_HOSTS=www.india.gov.in,india.gov.in`,
  `ACCESSIBILITY_ALLOWED_ASSET_ORIGINS` (11 exact HTTPS origins; needs developer
  confirmation, see §5), `ACCESSIBILITY_TRUST_PROXY=true` (one Cloud Run proxy hop;
  without it all clients share one rate-limit bucket), `ACCESSIBILITY_ALLOW_LOCAL=false`,
  `ACCESSIBILITY_SCAN_TIMEOUT_MS=45000`.
- Self-URL vars (`ACCESSIBILITY_ALLOWED_ORIGINS`, `ACCESSIBILITY_PUBLIC_BASE_URL`)
  are intentionally absent at first deploy. The config parser accepts that: the
  public-base-URL links are added only when it is set.
- The SSRF, redirect, and private-address defenses are implemented by the scan
  engine. This section wires env vars only and claims no isolation beyond what the
  engine implements and verifies.

## 5. Known gaps / blockers (honest)

- **Cloud Run is not deployed.** The public fixture URL, the government-domain
  scans from the deployed service, and the orchestrator's acceptance are all pending.
- `ACCESSIBILITY_ALLOWED_ASSET_ORIGINS` (11 origins) needs developer confirmation
  before deploy. AGENTS.md says not to extend the allowlist without the developer.
  Only 7 origins were observed in the root HTML. The other 4 (`static.india.gov.in`,
  `fonts.googleapis.com`, `fonts.gstatic.com`, `translation-plugin.bhashini.co.in`)
  are CSP-only.
- `ACCESSIBILITY_TRUST_PROXY=true` is a DevOps decision for Cloud Run's single
  proxy hop. Orchestrator to confirm.
- Comment-only staleness in files already in the built source snapshot:
  `Dockerfile` still says "ACTION REQUIRED before the first build" and
  `deploy/cloudbuild.yaml` header says "do NOT build yet". Fixing the comments changes
  the uploaded source, so do it with the next rebuild. Behavior is unaffected.
- `npm test` (Vitest) and the frontend tests are **not** run inside the image build.
  The orchestrator owns test gates.
- No caps, sizing, or pricing guarantees are made anywhere in this document.

## 6. Cleanup (after the hackathon — run ONLY if the user decides; do not run now)

```bash
PROJECT=project-f788c2f2-5518-4c6d-847
REGION=asia-south1

# Cloud Run service (if deployed)
gcloud run services delete ac-demo --project=$PROJECT --region=$REGION --quiet
# other demo services (e.g. public fixture) — list first:
gcloud run services list --project=$PROJECT --region=$REGION

# Image repo
gcloud artifacts repositories delete ac-demo --project=$PROJECT --location=$REGION --quiet

# Buckets (objects were lifecycle-deleted; force-remove remaining/bg data)
gcloud storage rm -r gs://ac-src-672419407385
gcloud storage rm -r gs://ac-runs-672419407385

# Service accounts and their bindings (bindings first)
for SA in ac-demo-build ac-demo-runtime; do
  EMAIL=$SA@$PROJECT.iam.gserviceaccount.com
  gcloud projects remove-iam-policy-binding $PROJECT \
    --member=serviceAccount:$EMAIL --role=roles/logging.logWriter --project=$PROJECT
  gcloud artifacts repositories remove-iam-policy-binding ac-demo \
    --location=$REGION --member=serviceAccount:$EMAIL \
    --role=roles/artifactregistry.writer --project=$PROJECT
  gcloud iam service-accounts delete $EMAIL --project=$PROJECT --quiet
done
# bucket-level objectUser/objectCreator/objectViewer bindings disappear with the buckets.

# API disable (optional; safe only after all resources are gone)
gcloud services disable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --project=$PROJECT
```

Never disable `serviceusage.googleapis.com`, `logging.googleapis.com`,
`monitoring.googleapis.com` — project-wide basics. Never touch global gcloud
config, unrelated IAM roles/resources, or billing.

# Dashbird cybersecurity plan

Dashbird runs in two modes:

1. **LAN** ([`docker-compose.yml`](../docker-compose.yml)) — trusted home Wi‑Fi; no public port-forward of 8787.
2. **Public cloud** (Vultr + jayhasty.com — [`deploy-vultr.md`](deploy-vultr.md)) — HTTPS via Caddy with **HTTP basic auth** required; personal `data/` never in git.

## 1) Ownership and review cadence

- Security owner: repo maintainer (default: Jay).
- **Weekly:** dependency review, skim logs for anomalies.
- **Monthly:** secrets checklist + run core smoke (`npm run smoke:core`).
- **Per meaningful release:** security review pass on changed routes and env handling.

## 2) Threat model

### Local LAN

| Risk | Mitigation |
|------|------------|
| Anyone on LAN opens dashboard | Accept for trusted home Wi‑Fi; do **not** port-forward 8787 to the internet |
| Leaked API keys in git | `.env` gitignored; rotate on exposure |
| Dependency vulnerabilities | Regular SCA + triage |
| Upstream fetch abuse / SSRF-style bugs | Outbound URLs validated against a private/link-local/metadata blocklist (`src/lib/public-http-url.js`) — used by Tool Library **and** Network enrich page fetch + avatar/logo download |
| Prompt-injected LLM output driving server fetches | Enrich `avatarImageUrl`/page URLs from the model pass the same public-URL guard before any fetch |
| Secrets in logs/telemetry | Never log keys; ratings telemetry is non-PII |

### Public cloud (`dashbird.jayhasty.com`)

| Risk | Mitigation |
|------|------------|
| Open internet reachability | Caddy TLS + **HTTP basic auth** (`DASHBOARD_BASIC_AUTH_*` in `.env`) |
| Brute-force / credential stuffing | Strong unique password; optional Vultr firewall lock SSH to your IP |
| Passwordless bind via leaked device UUID | `/auth/device-bind` now **requires one basic-auth challenge** before binding (UUID alone is not enough) and is **rate-limited** per IP |
| Personal CRM / events / tools on disk | Bind-mounted `data/` only; never commit; **off-host encrypted** nightly copy via `scripts/cloud-backup.sh` (rclone + age/gpg) |
| Host loss / disk failure / ransomware | Off-host encrypted backups + [`recovery-runbook.md`](recovery-runbook.md) (RPO ~24h, RTO ~30–60 min); staleness alert if backups stop |
| OAuth redirect misuse | Set Gmail (and other) redirect URIs to the public HTTPS origin only |
| Oversized attack surface | Slim `Dockerfile.cloud` (no Playwright/Chromium on 2 GB VPS) |

## 3) Secrets handling

- Never commit secrets, API keys, tokens, or private URLs.
- Runtime secrets live in `.env` only.
- `.env.example` holds placeholders only.
- On exposure: revoke/rotate immediately, then re-test integrations.

## 4) Dependency and supply-chain hygiene

- Use `npm install` / `npm update` — avoid hand-editing lockfiles.
- Before new dependencies: check maintainer activity and known issues.
- After dependency changes: run an SCA check; record accepted risks with reason.

## 5) Chosen audit stack

Decided 2026-07-09 from the §6 evaluation. Stack is **free / built-in first**; no commercial scanner MCP or IDE extension is wired unless explicitly requested later.

| Check | When | Approach |
|-------|------|----------|
| Dependency vulnerabilities (SCA) | Weekly + on dep changes | `npm audit` locally; triage high/critical; document accepts |
| Automated dependency PRs | Ongoing | GitHub **Dependabot** (npm + Docker base image alerts) — enable when ready; manual merge only |
| Static analysis (SAST) | On meaningful feature PRs / large diffs | **No dedicated SAST product** for now — Cursor security review covers first-party route/env/fetch patterns better for this app size |
| Container / image | Monthly (optional) | **Trivy** (or equivalent) against the built image when touching `Dockerfile` / base tag; do not chase every Playwright/OS CVE on a LAN-only box |
| Secrets | Continuous + monthly checklist | GitHub **secret scanning** (and push protection if available) + keep `.env` gitignored; optional local `gitleaks` before unusual commits |
| AI / human review | On meaningful feature PRs | Cursor security review (or equivalent) on changed routes, env handling, and upstream `fetch` |
| Runtime sanity | Before/after deploy | `npm run smoke:core` |

For each finding: severity, owner, fix or documented accept-with-reason, target date.

**Explicitly deferred (not installed):** commercial SCA/SAST (Snyk, etc.), Semgrep/CodeQL as standing gates, Renovate (Dependabot is enough on GitHub), always-on container CI, pre-commit hook farms.

## 6) Tooling evaluation (decided)

**Status:** decided 2026-07-09. Candidates were scored side by side against the same criteria; prior IDE experiments and leftover config did **not** weight any vendor.

**Repo facts used:** GitHub remote (`heyhastyjay/dashbird`); no CI workflows yet; Node 20+ Express app with lockfile; Docker image based on `mcr.microsoft.com/playwright` (large OS surface); threat model is LAN-only (§2).

### Decision criteria (applied to every candidate)

1. **Fit** — covers a real risk in §2 for this repo.
2. **Cost** — free tier vs paid; surprise billing risk.
3. **Friction** — IDE popups, OAuth, agent MCP noise, CI minutes.
4. **Signal quality** — false positives vs actionable findings.
5. **Where it runs** — local only, CI, or both.
6. **Maintenance** — who owns updates and triage.

### Capability buckets

#### SCA (dependencies)

| Candidate | Fit | Cost | Friction | Signal | Where | Maintenance | Verdict |
|-----------|-----|------|----------|--------|-------|-------------|---------|
| `npm audit` | High — lockfile vulns | Free | Low (CLI) | Good enough; some noise | Local | Maintainer triage | **Chosen (baseline)** |
| GitHub Dependabot | High — PRs + alerts | Free on GitHub | Low | Good for npm | Host | Merge/ignore PRs | **Chosen (automation)** |
| Renovate | High | Free (self-host or app) | Medium (config) | Good | Host/CI | Extra bot vs Dependabot | Skip — overlaps Dependabot |
| Commercial SCA (e.g. Snyk) | High | Paid risk | Medium–high (IDE/MCP) | Often strong | Local/CI/cloud | Vendor + triage | **Defer** — overkill for LAN-only |

#### SAST (first-party code)

| Candidate | Fit | Cost | Friction | Signal | Where | Maintenance | Verdict |
|-----------|-----|------|----------|--------|-------|-------------|---------|
| Cursor security review | High for routes/env/fetch | Included in Cursor | Low (on-demand) | Context-aware on diffs | Local / PR | Per meaningful PR | **Chosen (process)** |
| Semgrep (OSS rules) | Medium | Free | Medium (CLI/CI setup) | Mixed on small Express apps | Local/CI | Rule updates + triage | **Defer** — add only if review misses recur |
| CodeQL | Medium | Free on GitHub | Needs Actions | Strong for some patterns | CI | Workflow ownership | **Defer** — no CI yet; optional later gate |
| ESLint security plugins | Low–medium | Free | Medium | Noisy / incomplete for SSRF | Local | Lint config | Skip for now |
| Commercial SAST | Medium | Paid | High | Variable | Cloud/IDE | Vendor | **Defer** |

#### Container / image

| Candidate | Fit | Cost | Friction | Signal | Where | Maintenance | Verdict |
|-----------|-----|------|----------|--------|-------|-------------|---------|
| Trivy / Grype (ad hoc) | Medium — base + layers | Free | Low if manual | Playwright/jammy will flood CVEs | Local | Spot-check on Dockerfile changes | **Chosen (optional monthly / on Dockerfile change)** |
| Registry / host scanners | Medium | Varies | Medium | Same noise problem | Host | Extra surface | Skip |
| Commercial container scan | Medium | Paid | Medium | Same | Cloud | Vendor | **Defer** |
| Always-on image CI gate | Low for LAN threat model | Free minutes still cost attention | High noise | Poor signal/noise on Playwright base | CI | Constant triage | **Defer** |

#### Secrets

| Candidate | Fit | Cost | Friction | Signal | Where | Maintenance | Verdict |
|-----------|-----|------|----------|--------|-------|-------------|---------|
| `.env` gitignore + rotate | Critical | Free | None | N/A (prevention) | Local | Discipline | **Chosen (required)** |
| GitHub secret scanning (+ push protection) | High | Free (public; check private plan) | Low | High for known patterns | Host | Rare true positives | **Chosen** |
| `gitleaks` / `trufflehog` (ad hoc) | High | Free | Low | High | Local | Occasional run | **Optional** before unusual commits |
| Pre-commit secret hooks everywhere | Medium | Free | Medium (hook friction) | High | Local | Hook upkeep | Skip unless leaks recur |

#### Process / review

| Candidate | Fit | Cost | Friction | Signal | Where | Maintenance | Verdict |
|-----------|-----|------|----------|--------|-------|-------------|---------|
| Cadence in §1 + finding triage | High | Free | Low | Human judgment | Local | Owner | **Chosen** |
| Cursor security review on meaningful PRs | High | Included | Low | Good for this codebase | Local | Per PR | **Chosen** |
| Formal external audit | Low for home LAN | Paid | High | High | External | Rare | Skip unless threat model changes |
| PR security checklist (short) | Medium | Free | Low | Reminder only | Host | Keep short | Optional add-on |

### Decision summary

| Bucket | Choice | Why |
|--------|--------|-----|
| SCA | `npm audit` + GitHub Dependabot | Covers §2 dependency risk; free; low friction; native to this forge |
| SAST | None as a product; Cursor review on meaningful PRs | App-specific risks (SSRF, env, route hardening) beat generic rule packs at this size |
| Container | Optional Trivy on Dockerfile / monthly | Real base-image risk exists, but always-on gates drown in Playwright OS noise |
| Secrets | Gitignore + GitHub scanning (+ optional gitleaks) | Highest-severity LAN-adjacent failure mode is key leak to git |
| Process | §1 cadence + Cursor review + smoke | Matches ownership model; no vendor lock-in |

**Revisit when:** public internet exposure, app login / multi-user, paid CI gates desired, or recurring missed findings that a Semgrep/CodeQL rule would have caught.

## 7) Runtime/API hardening

- Validate and sanitize request input on server routes.
- Fail closed when external provider keys are missing.
- Conservative timeouts on upstream `fetch`.
- Avoid leaking stack traces or internal paths in API errors.

## 8) Logging and telemetry

- Tool library ratings telemetry (`/api/tool-library/ratings/debug`) tracks source, null-rate, latency — no secrets/PII.
- Trim or rotate container logs on long-running hosts if needed.

## 9) Incident response (quick)

1. Contain — stop container or disable affected route.
2. Rotate — revoke exposed secrets.
3. Assess — scope (routes, data, keys).
4. Recover — patch and redeploy (`docker compose down && docker compose up -d --build`).
5. Verify — `npm run smoke:core` + targeted checks.
6. Document — timeline and prevention.

## 10) Hardening changelog (2026-07-20)

Closed from the [ops-review blast-radius](ops-review-backup-blast-radius.md) findings:

- **SSRF in Network enrich** — page fetch (`fetchPageText`), image download (`fetchRemoteImageBytes`),
  and caller-supplied `fetchUrls` now go through `assertPublicHttpUrl`/`looksLikePublicHttpUrl`.
  Prevents LLM- or content-driven fetches to internal/metadata addresses.
- **Backups off-host + encrypted** — `scripts/cloud-backup.sh` encrypts (age/gpg) and uploads
  (rclone) the daily tarball off the VPS; refuses to upload plaintext.
- **Backup gaps closed** — all five SQLite DBs snapshotted (added `dev-requests.db` + Vikunja),
  startup catch-up for missed days, and a Telegram staleness alert.
- **Device-bind hardened** — requires a basic-auth challenge before binding + per-IP rate limit.
- **Safe destructive deploy** — `SYNC_DATA=1` defaults to dry-run and snapshots remote `data/`
  before overwrite (`SYNC_DATA_CONFIRM=1` to commit).
- **Recovery runbook** — [`recovery-runbook.md`](recovery-runbook.md) with RPO/RTO and per-scenario steps.

Still open (accepted or deferred): LAN has no auth (trusted Wi-Fi); LAN container runs as root
with DBus/X11 for desktop tiles; single `.env` holds all secrets; `POST /api/dev-requests` is
unauthenticated on LAN and feeds coding agents (treat inbox as untrusted before running agents).

## 11) Backlog

- [x] Dependabot config in-repo: [`.github/dependabot.yml`](../.github/dependabot.yml) (npm + Docker, weekly, manual merge). Takes effect after this file is on the default branch.
- [ ] GitHub UI (needs repo admin; no `gh`/token on this host yet):
  1. **Settings → Code security** — enable **Dependabot alerts** and **Dependabot security updates** (version updates come from the YAML above).
  2. Same page — enable **Secret scanning** and **Push protection** (availability depends on public vs private / plan).
- Optional: ad hoc Trivy after Dockerfile or base-tag changes; optional local `gitleaks`.
- Optional later: CI gate for `npm audit` + `smoke:core` on push (no commercial scanners unless requested).
- Security review when adding non-OpenRouter AI providers (v2).

---
version: 1
lastUpdated: 2026-08-02T19:21:09.252Z
sourceLang: en
contentHash: 2bc7ce42ef0ae829
codeVerified: 2026-08-02T19:21:09.252Z
codeVerifiedHash: 2bc7ce42ef0ae829
codeVerifiedClaims: 8
---

# Google Cloud Deployment (single VM)

This guide deploys the full LumiBase stack to a single **Google Compute Engine**
VM with `docker compose`, using **Gemini** as the LLM provider. It is the
cheapest deployment that satisfies the "runs on Google Cloud" requirement while
keeping LumiBase's long-lived background jobs working correctly.

## Why a VM and not Cloud Run

The Node entrypoint (`apps/cms/src/serve.ts`) runs several `node-cron` jobs in
the same long-lived process:

- content scheduler tick (`* * * * *`)
- veto-window commit sweep (`*/5 * * * *`)
- audit-log retention rotation (`0 * * * *`)
- async agent-run worker consuming the Redis queue

A scale-to-zero / multi-instance serverless target (Cloud Run with default
settings) would **skip these when idle** and **double-fire them when more than
one instance is live**. Running Cloud Run safely would require pinning
`min-instances=1, max-instances=1` plus external Cloud SQL, Memorystore, GCS,
and MeiliSearch — more moving parts and higher cost for no benefit at this
scale. One small VM running the bundled stack is simpler and cheaper.

> When you outgrow a single VM, the upgrade path is: move Postgres to Cloud SQL,
> Redis to Memorystore, media to GCS, and keep the CMS on the VM (or a pinned
> single-instance Cloud Run service). Revisit then, not now.

## What you need

- A Google Cloud project with billing enabled.
- The `gcloud` CLI authenticated locally (`gcloud auth login`).
- A Gemini API key from <https://aistudio.google.com/apikey>.

## 1. Create the VM

`e2-small` (2 vCPU burst, 2 GB RAM) is the practical minimum for the full stack;
use `e2-medium` (4 GB) if you see OOM kills under load. Adjust `--zone` to a
region near your customers.

```bash
gcloud compute instances create lumibase \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --zone=asia-southeast1-a \
  --tags=lumibase-http
```

Open the CMS port (1989). For a real domain, put a TLS reverse proxy in front
(see [Note on TLS](#note-on-tls)) and only expose 80/443 instead.

```bash
gcloud compute firewall-rules create lumibase-http \
  --allow=tcp:1989 \
  --target-tags=lumibase-http \
  --description="LumiBase CMS API"
```

## 2. Provision Docker on the VM

SSH in and run the setup script (installs Docker Engine + compose plugin):

```bash
gcloud compute ssh lumibase --zone=asia-southeast1-a

# on the VM:
git clone https://github.com/khuepm/lumibase.git
cd lumibase
bash docker/scripts/gcp-vm-setup.sh
# re-login (or `newgrp docker`) so your user can run docker without sudo
```

## 3. Configure secrets

```bash
cd ~/lumibase/docker
cp .env.prod.example .env
```

Fill **every** value in `.env`. The file documents an `openssl` command for each
secret. Two boot-time guards will stop a misconfigured stack:

- the `docker-compose.gcp.yml` overlay aborts if a required variable is empty;
- the CMS runs `validateProductionConfig()` on startup and refuses to boot on a
  missing secret, a leftover dev default (`minioadmin`, `lumibase_dev_key`,
  `736563726574`), a non-AES `ENCRYPTION_KEY`, or a `*` CORS origin.

Set `LLM_PROVIDER=gemini` and paste your `GEMINI_API_KEY`.

## 4. Build and start

```bash
docker compose -f docker-compose.yml -f docker-compose.gcp.yml up -d --build
```

This builds the production image (`docker/Dockerfile`) on the VM, runs database
migrations via the entrypoint, then starts the CMS plus Postgres, Redis, MinIO,
MeiliSearch, and imgproxy on a private Compose network. Only the CMS port is
published.

## 5. Verify

```bash
# health
curl -fsS http://localhost:1989/health

# follow CMS logs (look for "Started in docker mode on port 1989")
docker compose -f docker-compose.yml -f docker-compose.gcp.yml logs -f cms
```

From your laptop, hit the external IP:

```bash
gcloud compute instances describe lumibase --zone=asia-southeast1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
curl -fsS http://<EXTERNAL_IP>:1989/health
```

### Confirm Gemini is actually wired

`LLM_PROVIDER=gemini` with a valid key routes AI Copilot / agent reasoning calls
to `generativelanguage.googleapis.com`. If the key is missing or invalid the
provider factory falls back to the no-LLM `echo` provider and logs
`GEMINI_API_KEY not set, falling back to echo provider` — grep the CMS logs for
that line to confirm you are NOT on the fallback. After exercising the Copilot,
confirm token usage in **Google AI Studio → API keys** (or Cloud console billing
if using a Cloud-billed key).

## Operating the stack

```bash
# update to latest code
cd ~/lumibase && git pull
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gcp.yml up -d --build

# stop
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gcp.yml down

# backups — Postgres volume is the source of truth; see docker/scripts/backup.sh
```

## Note on TLS

Port 1989 is plain HTTP. For anything customer-facing, terminate TLS with a
reverse proxy and stop exposing 1989 publicly. The repo ships a Caddy overlay
(`docker/docker-compose.tls.yml`, `docker/Caddyfile`) that obtains Let's Encrypt
certs automatically — set `PUBLIC_DOMAIN` and `ACME_EMAIL`, point your DNS A
record at the VM's external IP, and add that overlay to the compose command.

## Submission evidence (Build with Gemini XPRIZE)

This deployment produces several of the artifacts the judges verify (see
[`devpost-xprize-submission.md`](../devpost-xprize-submission.md)):

- **AI running in production** — agent execution rows in `agent_runs` /
  `agent_goals`, exportable from Postgres; Mission Control screenshots from
  Studio.
- **Gemini usage** — token/request counts from Google AI Studio or Cloud
  console billing, tied to the key in `.env`.
- **Product live on Google Cloud** — the VM's external URL responding to
  `/health`.
```

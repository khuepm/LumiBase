#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Provision a fresh Debian/Ubuntu Compute Engine VM to run the LumiBase stack.
#
# Installs Docker Engine + the compose plugin from Docker's official apt repo,
# then prints the next steps. It does NOT clone the repo, write secrets, or
# start containers — those are explicit, reviewable steps the operator runs.
#
# Idempotent: re-running skips anything already installed.
#
# Usage (on the VM):
#   curl -fsSL <raw-url>/docker/scripts/gcp-vm-setup.sh | bash
#   # or, after cloning the repo:
#   bash docker/scripts/gcp-vm-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

log() { printf '\033[1;34m[gcp-setup]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[gcp-setup]\033[0m %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  err "Run as root or install sudo first."
  exit 1
fi
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker + compose plugin already installed: $(docker --version)"
else
  log "Installing Docker Engine + compose plugin..."
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg

  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    . /etc/os-release
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  . /etc/os-release
  CODENAME="${VERSION_CODENAME:-$(lsb_release -cs 2>/dev/null || echo stable)}"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  $SUDO apt-get update -y
  $SUDO apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  $SUDO systemctl enable --now docker
  log "Installed: $(docker --version)"
fi

# Let the invoking (non-root) user run docker without sudo on next login.
TARGET_USER="${SUDO_USER:-$(whoami)}"
if [ "$TARGET_USER" != "root" ]; then
  $SUDO usermod -aG docker "$TARGET_USER" || true
  log "Added '$TARGET_USER' to the docker group (re-login or 'newgrp docker' to apply)."
fi

cat <<'NEXT'

────────────────────────────────────────────────────────────────────────────
Next steps
────────────────────────────────────────────────────────────────────────────
  1. Clone the repo (if you piped this script in):
       git clone https://github.com/khuepm/lumibase.git
       cd lumibase/docker

  2. Create and fill the production env file:
       cp .env.prod.example .env
       # generate secrets with the openssl commands documented in that file,
       # then paste your GEMINI_API_KEY from https://aistudio.google.com/apikey

  3. Build and start the stack:
       docker compose -f docker-compose.yml -f docker-compose.gcp.yml up -d --build

  4. Verify:
       curl -s http://localhost:1989/health
       docker compose -f docker-compose.yml -f docker-compose.gcp.yml logs -f cms

Full guide: docs/en/deployment/google-cloud-vm.md
────────────────────────────────────────────────────────────────────────────
NEXT

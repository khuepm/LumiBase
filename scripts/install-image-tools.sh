#!/usr/bin/env bash
# Install the container supply-chain tools used by the image workflows (#734):
# Trivy (vulnerability gate), Syft (SBOM) and cosign (keyless signing).
#
#   scripts/install-image-tools.sh trivy syft cosign
#
# Pinned by version AND SHA-256, the same rule ci.yml applies to actionlint,
# rather than pulling third-party actions: the binary is verified before it
# runs, and a moved or re-pushed tag cannot change what executes. That matters
# here in particular — the release job that runs these holds `packages: write`
# and an OIDC token that can sign images.
#
# To bump a tool: change its version and copy the matching line for the
# linux/amd64 asset from that release's published checksums file.
#
# Installs into $RUNNER_TEMP/image-tools (or ./.image-tools) and appends that
# directory to $GITHUB_PATH when running under Actions.
set -euo pipefail

TRIVY_VERSION=0.76.2
TRIVY_SHA256=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
SYFT_VERSION=1.57.1
SYFT_SHA256=bf52519eb57f675d47c07d43213cb6dff6449f3d6d1147ff6701ed91f44eef0c
COSIGN_VERSION=3.1.4
COSIGN_SHA256=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa

dest="${RUNNER_TEMP:-$PWD}/image-tools"
mkdir -p "$dest"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # url sha256 output
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum --check --strict
}

for tool in "$@"; do
  case "$tool" in
    trivy)
      fetch "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
        "$TRIVY_SHA256" "$work/trivy.tar.gz"
      tar -xzf "$work/trivy.tar.gz" -C "$dest" trivy
      "$dest/trivy" --version
      ;;
    syft)
      fetch "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_amd64.tar.gz" \
        "$SYFT_SHA256" "$work/syft.tar.gz"
      tar -xzf "$work/syft.tar.gz" -C "$dest" syft
      "$dest/syft" version
      ;;
    cosign)
      fetch "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64" \
        "$COSIGN_SHA256" "$dest/cosign"
      chmod +x "$dest/cosign"
      "$dest/cosign" version
      ;;
    *)
      echo "unknown tool: $tool (expected trivy, syft or cosign)" >&2
      exit 2
      ;;
  esac
done

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest" >> "$GITHUB_PATH"
fi

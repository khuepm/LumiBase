---
version: 1
lastUpdated: 2026-07-25T08:15:55.058Z
sourceLang: vi
translatedFrom: vi
sourceHash: 7753c4091c7b68a7
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:15:55.058Z
codeVerifiedHash: 7753c4091c7b68a7
codeVerifiedClaims: 8
---

# Extension Marketplace UI

LumiBase Studio ships a visual **Extension Marketplace** that lets an administrator search, inspect and install extensions to expand what the CMS can do.

## Main features

The Marketplace page is mounted directly under **Settings → Marketplace** (`/settings/marketplace`) and offers:

### 1. Extension browser
- **Grid layout**: extensions are listed as responsive cards showing the extension name, publisher, current version, and classification badges.
- **Live filters**: search by keyword (name, publisher, slug) and filter by category (Module, Interface, Display, Layout, Panel, Endpoint).

### 2. Detail modal and permissions
Click **View details** on any card to open the detail dialog:
- **Description**: what the extension does and why you would want it.
- **Capabilities**: the additional capabilities the extension provides to the CMS.
- **Requested permissions**: the permissions the extension is asking for — rendered as amber badges as a safety warning.
- **Cryptographic signature**: the system verifies the extension's signature against the vetted publisher's Key ID, protecting bundle integrity and preventing source tampering.

### 3. One-click install
- Press **Install** to download and register the extension against the current site.
- Install state is reflected immediately in the UI via a green **Installed** badge, which prevents installing the same extension twice.

---

## API architecture and integration

The UI talks directly to these endpoints:

- `GET /api/v1/marketplace/extensions` — returns the extensions published and verified on the Marketplace.
- `GET /api/v1/marketplace/extensions/:slug` — fetches one extension's manifest detail (description, capabilities, permissions, bundle URL, …).
- `POST /api/v1/marketplace/extensions/:slug/install` — installs the extension into the caller's current site.
- `GET /api/v1/extensions` — lists the successfully installed extensions, used to render install state.

## Permissions

To reach and act in the Marketplace, a user needs the `extensions:read` and `extensions:write` permissions granted through Policies.

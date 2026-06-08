# Private Admin Path

The private admin path is the secret Studio entry point created during setup, for example `/lumi-7f3a9c`. It replaces predictable paths such as `/admin` and reduces automated login discovery.

## Security Rules

- Store the private admin path only as server-side state after setup.
- Do not expose it through `VITE_*` environment variables, static config, build metadata, public docs, analytics, or unauthenticated API responses.
- Do not automatically redirect public or setup URLs to the private admin path in production.
- Return a hard "Not found" style response for initialized setup routes and incorrect Studio paths instead of revealing the configured admin URL.
- Show the private admin path only to the operator at the end of setup or through an authenticated recovery flow.
- Mask the private admin path in logs and audit payloads unless a trusted diagnostic path explicitly needs it.

## Production Redirect Policy

In production, LumiBase must never use the stored admin path as a convenience redirect target. Requests such as `/`, `/setup`, `/setup/*`, or another non-admin Studio path must not automatically navigate to `/<private-admin-path>` or `/<private-admin-path>/login`.

This prevents the browser address bar, referrers, proxies, monitoring tools, or screenshots from revealing the private admin path during normal setup completion or later probing.

Local development may keep convenience redirects to speed up testing, but production behavior is authoritative and must remain no-redirect.

## Operator Guidance

After setup, save the full admin login URL and backup codes in a secure password manager. Losing both the private admin path and recovery material requires an operator recovery flow or direct administrative intervention.

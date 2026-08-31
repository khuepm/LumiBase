---
title: "The Server That Robs Itself: How We Shut Down SSRF in Lumibase"
published: false
tags: security, webdev, typescript, cloud
cover_image:
---

Imagine your company has a courier everyone trusts completely. You hand him an address, he drives there, picks up the package, and brings it back — no questions asked. Most of the time customers give him a normal street address, so everything is fine. Then one day a con artist hands him an address that points *inside your own building* — straight to the vault where every key and password is kept. The courier, being helpful, walks in, grabs the contents, and cheerfully hands them to the con artist, never realizing he just helped rob the place.

That courier is your server. That con artist is an attacker. And that little heist has a name: **Server-Side Request Forgery (SSRF)** — CWE-918.

This is the story of how Lumibase closed that door.

## What SSRF actually is

Lots of applications need to fetch a URL on the user's behalf: importing an image from a link, verifying a webhook endpoint, rendering a link preview, pulling a remote config. The user provides a URL, and the server makes the request.

SSRF happens when an attacker supplies a URL that points somewhere they shouldn't be able to reach — and the server, which usually lives *inside* the trusted network, dutifully makes the request for them. The attacker never touches the internal network directly; they borrow the server's privileges, and the firewall waves the request through because it came from a machine it trusts.

The classic targets:

- Internal services that are only reachable from inside the network (admin panels, databases, dashboards).
- `localhost` / loopback services bound to `127.0.0.1`.
- Link-local addresses.
- And the crown jewel in the cloud: the **instance metadata endpoint**.

## Why the metadata endpoint makes SSRF terrifying

On most cloud platforms there is a special internal address — `169.254.169.254` — that any instance can call to retrieve information about itself, including **temporary credentials**. It's convenient for the platform and lethal in the wrong hands.

If an attacker can trick your server into fetching `http://169.254.169.254/…`, the response can hand them the keys to the kingdom: cloud credentials scoped to whatever your instance can do. That is essentially the shape of the breach that leaked personal data of over a hundred million customers at a major US bank a few years ago. One trusted server, one carefully chosen URL, one very bad day.

The scary part of SSRF is not brute force. It's misplaced trust.

## How Lumibase fixed it

Lumibase is an edge-native, AI-native headless CMS being reshaped into a Content OS, so it does plenty of legitimate server-side fetching — extension bundles, remote resources, and outbound calls made by governed agents. Every one of those is a potential SSRF sink. Rather than sprinkle ad-hoc checks around, we put a single guard in front of *every* request the server makes on a user's behalf.

The guard runs before the fetch and enforces a strict deny list of destinations. Conceptually:

1. **Parse and resolve the target.** Never trust the raw string. Resolve the hostname to its actual IP(s) so a friendly-looking domain can't smuggle you to an internal address.
2. **Reject anything that isn't a real, public destination**, specifically:
   - Private ranges (RFC 1918): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
   - Loopback: `127.0.0.0/8` and `::1`
   - Link-local: `169.254.0.0/16` and `fe80::/10`
   - The cloud metadata endpoint (`169.254.169.254`) explicitly
   - Unspecified / reserved / unique-local ranges
3. **Cover IPv6 too.** Attackers love format tricks — IPv6, IPv4-mapped IPv6 (`::ffff:169.254.169.254`), decimal or hex-encoded IPs. The guard normalizes and checks both families so nobody sneaks in by changing notation.
4. **Fail closed.** If the address can't be confidently classified as safe and public, the request is blocked, not allowed.

Here is a *representative* (simplified, illustrative) version of the approach — not a verbatim copy of the production file, but it captures what the guard does:

```typescript
// ssrf-guard.ts — illustrative version of the approach
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

// Ranges we never allow a server-side fetch to reach.
const BLOCKED_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",       // loopback
  "169.254.0.0/16",    // link-local, incl. 169.254.169.254 metadata
  "::1/128",           // IPv6 loopback
  "fe80::/10",         // IPv6 link-local
  "fc00::/7",          // IPv6 unique-local
];

function isBlockedIp(ip: string): boolean {
  const addr = ipaddr.parse(ip);
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) to IPv4.
  const normalized =
    addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ? (addr as ipaddr.IPv6).toIPv4Address()
      : addr;

  return BLOCKED_RANGES.some((cidr) => {
    const [net, bits] = ipaddr.parseCIDR(cidr);
    return normalized.kind() === net.kind() &&
      normalized.match(net, bits);
  });
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SSRF: only http(s) is allowed");
  }

  // If the host is a literal IP, check it directly.
  if (isIP(url.hostname)) {
    if (isBlockedIp(url.hostname)) {
      throw new Error(`SSRF: blocked address ${url.hostname}`);
    }
    return url;
  }

  // Otherwise resolve the hostname and check every answer.
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(url.hostname, { all: true });
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new Error(`SSRF: ${url.hostname} resolves to blocked ${address}`);
    }
  }

  return url;
}
```

Then anywhere the server fetches on a user's behalf:

```typescript
const safeUrl = await assertSafeUrl(userProvidedUrl);
const res = await fetch(safeUrl);
```

Two details that matter as much as the list itself:

- **It's centralized.** One guard, applied to every outbound-on-behalf-of-user request, so there's no forgotten code path. In Lumibase this sits alongside the extension sandbox that only loads bundles from an allowlisted origin.
- **It's covered by tests.** The blocked ranges, the metadata endpoint, and the IPv6/encoding tricks all have test cases. So if a future refactor accidentally weakens the guard, the suite screams before it ships. A silent regression here is exactly the kind of thing that becomes a breach.

## The lesson

The most dangerous vulnerabilities usually aren't about a clever exploit chain. They're about trust that was never questioned. A helpful, obedient server that fetches whatever it's told is, in the wrong moment, more dangerous than the attacker — because it has credentials and network access the attacker doesn't.

So the rule we keep coming back to: **anything that goes out to the internet on a user's behalf must have its destination inspected before it's allowed to leave.** Validate, resolve, and fail closed.

We're building all of this in public. Lumibase is a Content OS — a headless, AI-native CMS operated by governed agents against declarative intents, with full provenance and earned autonomy. If this kind of security-first, build-in-public engineering is your thing, come hang out at [lumibase.dev](https://lumibase.dev). 🌱

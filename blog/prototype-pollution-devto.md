---
title: "The Key That Unlocks Everything: Prototype Pollution in JavaScript"
published: false
tags: security, javascript, webdev, typescript
cover_image:
---

Imagine a hotel where every room key is cut from a master template. When a guest checks in, the front desk hands them a key that opens only their room. Simple enough. Now imagine a guest who, during check-in, sneaks a tiny modification into the key-cutting machine itself — changing the template so that *every new key cut from that moment on* also opens the manager's office, the safe, and the server room.

The guest didn't break a lock. They didn't clone anyone's key. They changed the *factory* that makes all keys.

That factory is JavaScript's `Object.prototype`. And the attack is called **Prototype Pollution**.

## How JavaScript inheritance actually works

Every object in JavaScript secretly points to a parent object called its *prototype*. When you access `user.toString()` and `user` doesn't have a `toString` property, JavaScript climbs the prototype chain looking for it. At the top of that chain, for almost every plain object, sits `Object.prototype` — the universal ancestor.

This is the lookup chain for a simple object:

```
user → Object.prototype → null
```

If `Object.prototype.isAdmin` exists, then `user.isAdmin` is also truthy — even if `user` was created as `{}` and `isAdmin` was never set on it. Every object in the entire runtime inherits whatever is on `Object.prototype`.

That's a feature. Until it becomes a catastrophe.

## The attack: one JSON payload, every object poisoned

Suppose your API receives JSON from users — a content body, a settings blob, a webhook payload. You parse it with `JSON.parse` and merge it into an object. Standard stuff.

Now imagine the attacker sends this:

```json
{
  "__proto__": {
    "isAdmin": true
  }
}
```

And your code does something like this:

```javascript
function merge(target, source) {
  for (const key of Object.keys(source)) {
    if (typeof source[key] === "object") {
      merge(target[key] ??= {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const settings = merge({}, JSON.parse(userInput));
```

`Object.keys` includes `__proto__`. The merge walks into it and assigns `isAdmin = true` onto `Object.prototype`. From that moment forward, every plain object in the process has `isAdmin === true`:

```javascript
const freshObject = {};
console.log(freshObject.isAdmin); // true — even though it was never set
```

Your access check elsewhere:

```javascript
if (user.isAdmin) {
  // … this runs for every user now
}
```

No database changes. No JWT forgery. One JSON payload, and the entire authorization model is broken for the lifetime of that process.

## What happens after the prototype is polluted

The consequences cascade in ways that aren't always obvious:

**Authorization bypass** is the most direct: any property check that falls back to the prototype (`obj.isAdmin`, `obj.role`, `obj.permissions`) can be satisfied without the property ever being explicitly set on the object.

**Denial of service** is subtler: certain built-in methods (`Object.prototype.hasOwnProperty`, `Object.prototype.toString`) can be overwritten, breaking code that relies on them. A `hasOwnProperty` check on a polluted object throws instead of returning a boolean.

**Remote Code Execution via template engines** is the most alarming escalation. Several popular Node.js template libraries (including older versions of lodash's template, Handlebars, and Pug) read options from the object's prototype chain. A polluted property like `block` or `__defineGetter__` can cause the template engine to execute attacker-supplied code. CVE-2019-10744 (lodash < 4.17.12) and CVE-2021-23337 are real, exploited examples.

## Where it shows up in a headless CMS

A Content OS like LumiBase has rich surface area for this attack:

- **Content items**: editors submit arbitrary field maps as JSON
- **AI skills**: agent outputs are deserialized into structured objects
- **Webhooks and extensions**: third-party code sends payloads that get merged into internal state
- **Schema migrations**: config objects are built by merging defaults with user-provided overrides

Any code path that takes user-supplied JSON and *merges* it — rather than validating it through a strict schema — is a potential injection point.

## How LumiBase shuts it down

The fix has three layers, and each layer would have caught it even if the others didn't exist.

### 1. Zod schema validation strips unknown keys at the boundary

Every API route in LumiBase validates its request body through a Zod schema. Zod's default `z.object({})` behavior is to strip keys that aren't in the schema. `__proto__`, `constructor`, and `prototype` are never declared, so they never reach business logic:

```typescript
const ContentItemSchema = z.object({
  title: z.string(),
  body:  z.string(),
  meta:  z.record(z.string(), z.unknown()),
});

// Attacker sends { "__proto__": { "isAdmin": true }, "title": "…" }
// After parse: { title: "…", body: undefined }  ← __proto__ gone
const validated = ContentItemSchema.parse(JSON.parse(req.body));
```

Validation happens before any merge or spread. Poison that never enters the kitchen can't contaminate the food.

### 2. Prototype-safe merging for config and defaults

Where object merging is unavoidable (building default configs, extending AI skill options), we use `Object.hasOwn()` instead of `in` or relying on the prototype chain:

```typescript
function safeMerge<T extends object>(target: T, source: Record<string, unknown>): T {
  for (const key of Object.keys(source)) {
    // Reject keys that would climb the prototype chain
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const val = source[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      (target as Record<string, unknown>)[key] ??= {};
      safeMerge(
        (target as Record<string, unknown>)[key] as object,
        val as Record<string, unknown>
      );
    } else {
      (target as Record<string, unknown>)[key] = val;
    }
  }
  return target;
}
```

The explicit key filter is the primary guard. The Zod layer above means `__proto__` should never arrive here at all — but defense in depth means we don't rely on only one gate.

### 3. Null-prototype objects for accumulator patterns

Wherever we accumulate untrusted key-value pairs into a dictionary (caching computed field values, indexing content by slug, etc.), the accumulator is created with `Object.create(null)` rather than `{}`. A null-prototype object has no `__proto__` and no inherited properties at all — it is immune to pollution because there's nothing to pollute:

```typescript
// Safe accumulator: no prototype, no inheritance, nothing to poison
const index = Object.create(null) as Record<string, ContentItem>;
index[item.slug] = item; // setting a key never touches Object.prototype
```

## The pattern that causes most real-world cases

If I had to summarize where prototype pollution appears most often in production codebases, it's a single function signature:

```javascript
function extend(target, ...sources) {
  for (const src of sources) {
    for (const key in src) {          // ← "in" iterates the prototype chain
      target[key] = src[key];
    }
  }
}
```

The `for…in` loop climbs the prototype chain. Switching to `Object.keys()` (which returns only own enumerable properties) plus an explicit `__proto__` key check closes the door.

## The lesson

JavaScript's prototype chain is both its most elegant and most dangerous feature. The same lookup mechanism that lets every array have `.map()` without it being defined on each instance is the mechanism that lets an attacker define `.isAdmin` for every object without touching any of them directly.

The good news: Prototype Pollution is almost entirely preventable with schema validation at the boundary. If untrusted input is parsed into a strict typed structure before it reaches any merge or spread operation, the payload has nowhere to land.

**Validate inputs as if your object model depends on it. Because it does.**

We're building all of this in public. LumiBase is a Content OS — a headless, AI-native CMS operated by governed agents against declarative intents, with full provenance and earned autonomy. If security-first, build-in-public engineering is your thing, come see what we're up to at [lumibase.dev](https://lumibase.dev). 🌱

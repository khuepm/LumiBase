import { describe, expect, it } from "vitest";

import { createLumiClient, LumiError } from "../../client";
import { legacyRest } from "../legacy";

function createSdk(fetcher: typeof fetch) {
  return createLumiClient({
    url: "https://api.example.test",
    token: "dev:user",
    siteId: "site_1",
    fetcher,
  }).with(legacyRest());
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("schema resources", () => {
  it("exposes nested collection resources and legacy collection wrappers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createSdk(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: "col_1", siteId: "site_1", name: "posts" });
    });

    await sdk.schema.collections.create({ name: "posts", label: "Posts" });
    await sdk.schema.getCollection("posts");

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/api/v1/collections",
      "https://api.example.test/api/v1/collections/posts",
    ]);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ name: "posts", label: "Posts" }),
    );
  });

  it("supports field rename and delete options", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createSdk(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: "field_1", collectionId: "col_1", name: "title" });
    });

    await sdk.schema.fields.rename("posts", "headline", "title", {
      type: "string",
      interface: "input",
      confirmRiskyChange: true,
      migrationPlan: { strategy: "copy" },
    });
    await sdk.schema.fields.delete("posts", "subtitle", {
      confirmRiskyChange: true,
      backupToRevisions: true,
      force: true,
    });

    expect(calls[0]?.url).toBe(
      "https://api.example.test/api/v1/collections/posts/fields/title",
    );
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        type: "string",
        interface: "input",
        confirmRiskyChange: true,
        migrationPlan: { strategy: "copy" },
        name: "title",
        renameFrom: "headline",
      }),
    );
    expect(calls[1]?.url).toBe(
      "https://api.example.test/api/v1/collections/posts/fields/subtitle?confirmRiskyChange=true&backupToRevisions=true&force=true",
    );
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("exposes relation resources and legacy relation wrappers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createSdk(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: "rel_1",
        siteId: "site_1",
        manyCollection: "posts",
        manyField: "author_id",
        oneCollection: "authors",
      });
    });

    await sdk.schema.relations.create({
      manyCollection: "posts",
      manyField: "author_id",
      oneCollection: "authors",
      type: "m2o",
    });
    await sdk.schema.deleteRelation("rel_1");

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/api/v1/relations",
      "https://api.example.test/api/v1/relations/rel_1",
    ]);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("types schema diff and apply against the Directus parity contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createSdk(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/schema")) {
        return jsonResponse({
          collection: { id: "col_1", siteId: "site_1", name: "posts" },
          diff: { risk: "low", runtimeImpact: [], collection: { added: [], removed: [], changed: [] }, fields: { added: [], removed: [], changed: [] }, relations: { added: [], removed: [], changed: [] } },
          affectedCollections: ["posts"],
          event: { type: "schema.changed", siteId: "site_1", collection: "posts", affectedCollections: ["posts"], diff: { risk: "low", runtimeImpact: [], collection: { added: [], removed: [], changed: [] }, fields: { added: [], removed: [], changed: [] }, relations: { added: [], removed: [], changed: [] } } },
        });
      }
      return jsonResponse({
        risk: "medium",
        runtimeImpact: ["typegen_rebuild"],
        collection: { added: [], removed: [], changed: [] },
        fields: { added: [], removed: [], changed: [] },
        relations: { added: [], removed: [], changed: [] },
      });
    });

    const diff = await sdk.schema.diff("posts", {
      fields: [{ name: "title", type: "string", interface: "input" }],
      relations: [],
    });
    const applied = await sdk.schema.apply("posts", {
      fields: [{ name: "title", type: "string", interface: "input" }],
    });

    expect(diff.data.risk).toBe("medium");
    expect(applied.data.event.type).toBe("schema.changed");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/api/v1/collections/diff",
      "https://api.example.test/api/v1/collections/posts/schema",
    ]);
  });

  it("preserves schema error code, path, and risk metadata", async () => {
    const sdk = createSdk(async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              code: "FIELD_DELETE_REQUIRES_FORCE",
              message: "Field has data.",
              path: ["fields", "title"],
              risk: "high",
            },
          ],
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(sdk.schema.fields.delete("posts", "title")).rejects.toMatchObject({
      status: 409,
      body: {
        errors: [
          {
            code: "FIELD_DELETE_REQUIRES_FORCE",
            path: ["fields", "title"],
            risk: "high",
          },
        ],
      },
    });

    try {
      await sdk.schema.fields.delete("posts", "title");
    } catch (err) {
      expect(err).toBeInstanceOf(LumiError);
      expect((err as LumiError).body.errors[0]?.message).toBe("Field has data.");
    }
  });
});

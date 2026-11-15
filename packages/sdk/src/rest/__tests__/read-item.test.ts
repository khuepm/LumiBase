import { describe, expect, expectTypeOf, it } from "vitest";

import { createLumiClient } from "../../client";
import type { ItemRow, SchemaOf } from "../../types";
import { readItem } from "../index";

// Shape of what `lumibase types` emits: interfaces, not type aliases.
interface Posts {
  title: string | null;
  views?: number | null;
}
interface LumibaseCollections {
  posts: Posts;
}

type Schema = SchemaOf<LumibaseCollections>;

const row: ItemRow<{ title: string }> = {
  id: "p1",
  siteId: "site_1",
  collectionId: "c1",
  status: "published",
  data: { title: "Hello" },
  sort: 0,
} as ItemRow<{ title: string }>;

describe("readItem", () => {
  it("resolves with the row itself, not the `{ data }` envelope", async () => {
    const calls: string[] = [];
    const client = createLumiClient<Schema>({
      url: "https://api.example.test",
      token: "t",
      siteId: "site_1",
      fetcher: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ data: row }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await client.request(readItem("posts", "p1", ["title"]));
    expect(result).toEqual(row);
    expect(calls).toEqual(["https://api.example.test/api/v1/items/posts/p1?fields=title"]);
    expectTypeOf(result.data.title).toEqualTypeOf<string | null>();
  });
});

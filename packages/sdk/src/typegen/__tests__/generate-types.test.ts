import { describe, expect, it } from "vitest";

import { generateTypes } from "../index";
import type { TypegenManifest } from "../types";

describe("generateTypes", () => {
  it("includes primary keys, system metadata, nullable fields, and relation-expanded types", () => {
    const manifest: TypegenManifest = {
      version: 2,
      site: "site_1",
      collections: [
        {
          name: "authors",
          primaryKey: "id",
          primaryKeyField: "id",
          primaryKeyType: "uuid",
          fields: [
            {
              name: "id",
              type: "uuid",
              required: true,
              nullable: false,
              primaryKey: true,
              system: true,
              readonly: true,
              generated: true,
              encrypted: false,
              branded: "AuthorsId",
            },
            {
              name: "created_at",
              type: "datetime",
              required: true,
              nullable: false,
              system: true,
              readonly: true,
              generated: true,
              encrypted: false,
            },
            {
              name: "name",
              type: "string",
              required: true,
              nullable: false,
              system: false,
              readonly: false,
              generated: false,
              encrypted: false,
            },
          ],
          relations: [
            {
              field: "posts",
              kind: "o2m",
              target: "posts",
              manyCollection: "posts",
              manyField: "author_id",
              oneCollection: "authors",
              oneField: "posts",
              junctionCollection: null,
            },
          ],
        },
        {
          name: "posts",
          primaryKey: "id",
          primaryKeyField: "id",
          primaryKeyType: "nanoid",
          fields: [
            {
              name: "id",
              type: "string",
              required: true,
              nullable: false,
              primaryKey: true,
              system: true,
              readonly: true,
              generated: true,
              encrypted: false,
              branded: "PostsId",
            },
            {
              name: "author_id",
              type: "uuid",
              required: false,
              nullable: true,
              system: false,
              readonly: false,
              generated: false,
              encrypted: false,
              kind: "m2o",
              target: "authors",
              branded: "AuthorsId",
            },
            {
              name: "secret_note",
              type: "string",
              required: false,
              nullable: true,
              system: false,
              readonly: false,
              generated: false,
              encrypted: true,
            },
          ],
          relations: [
            {
              field: "author_id",
              kind: "m2o",
              target: "authors",
              manyCollection: "posts",
              manyField: "author_id",
              oneCollection: "authors",
              oneField: "posts",
              junctionCollection: null,
            },
          ],
        },
      ],
    };

    const output = generateTypes(manifest);

    expect(output).toContain("readonly id: Brand<'AuthorsId', string>;");
    expect(output).toContain("readonly created_at: string;");
    expect(output).toContain("author_id?: Brand<'AuthorsId', string> | null;");
    expect(output).toContain("secret_note?: string | '***' | null;");
    expect(output).toContain('export type AuthorsExpanded = Omit<Authors, "posts"> &');
    expect(output).toContain("posts?: Array<Posts | PostsExpanded>;");
    expect(output).toContain('export type PostsExpanded = Omit<Posts, "author_id"> &');
    expect(output).toContain("author_id?: Authors | AuthorsExpanded | null;");
  });

  it("maps integer primary keys to number", () => {
    const output = generateTypes({
      version: 2,
      site: "site_1",
      collections: [
        {
          name: "orders",
          primaryKey: "id",
          primaryKeyField: "id",
          primaryKeyType: "integer",
          fields: [
            {
              name: "id",
              type: "integer",
              required: true,
              nullable: false,
              primaryKey: true,
              system: true,
              readonly: true,
              generated: true,
              encrypted: false,
            },
          ],
          relations: [],
        },
      ],
    });

    expect(output).toContain("readonly id: number;");
    expect(output).toContain("export type OrdersExpanded = Orders;");
  });
});

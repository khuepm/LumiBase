import { describe, expect, it } from "vitest";
import { collections as collectionsTable, fields, relations } from "@lumibase/database";

import { TypegenService } from "../typegen-service";

function queryResult(rows: unknown[]) {
  return {
    orderBy: async () => rows,
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

function createDb() {
  const collectionRows = [
    {
      id: "col_posts",
      siteId: "site_1",
      name: "posts",
      label: "Posts",
      pluralLabel: "Posts",
      hidden: false,
      system: false,
      singleton: false,
      icon: null,
      color: null,
      note: null,
      primaryKeyField: "id",
      primaryKeyType: "uuid",
      storageMode: "jsonb",
      displayTemplate: null,
      sortField: "sort",
      archiveField: "status",
      archiveValue: "archived",
      unarchiveValue: "draft",
      itemDuplicationFields: [],
      translations: {},
      accountability: "all",
      versioning: false,
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
  const fieldRows = [
    {
      id: "field_title",
      siteId: "site_1",
      collectionId: "col_posts",
      name: "title",
      type: "string",
      interface: "input",
      display: null,
      label: "Title",
      note: null,
      defaultValue: null,
      nullable: false,
      unique: false,
      indexed: false,
      searchable: true,
      length: null,
      precision: null,
      scale: null,
      special: [],
      options: {},
      displayOptions: {},
      validation: { rules: [] },
      conditions: [],
      translations: {},
      required: true,
      readonly: false,
      hidden: false,
      encrypted: false,
      versioned: false,
      rawEnabled: true,
      width: "full",
      group: null,
      sortOrder: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "field_author",
      siteId: "site_1",
      collectionId: "col_posts",
      name: "author_id",
      type: "uuid",
      interface: "select-dropdown-m2o",
      display: null,
      label: "Author",
      note: null,
      defaultValue: null,
      nullable: true,
      unique: false,
      indexed: true,
      searchable: true,
      length: null,
      precision: null,
      scale: null,
      special: ["m2o"],
      options: {},
      displayOptions: {},
      validation: { rules: [] },
      conditions: [],
      translations: {},
      required: false,
      readonly: true,
      hidden: false,
      encrypted: true,
      versioned: false,
      rawEnabled: true,
      width: "full",
      group: null,
      sortOrder: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
  const relationRows = [
    {
      id: "rel_author",
      siteId: "site_1",
      manyCollection: "posts",
      manyField: "author_id",
      oneCollection: "authors",
      oneField: "posts",
      junctionCollection: null,
      type: "m2o",
      aliasField: null,
      relatedDisplayTemplate: null,
      junctionManyField: null,
      junctionOneField: null,
      sortField: null,
      onDelete: "set null",
      meta: {},
      createdAt: new Date(),
    },
  ];

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === collectionsTable) return queryResult(collectionRows);
          if (table === fields) return queryResult(fieldRows);
          if (table === relations) return queryResult(relationRows);
          return queryResult([]);
        },
      }),
    }),
  };
}

describe("TypegenService", () => {
  it("emits primary key, system field, field metadata, and relation descriptors", async () => {
    const service = new TypegenService({
      db: createDb() as never,
      siteId: "site_1",
    });

    const manifest = await service.getManifest();
    const posts = manifest.collections[0]!;

    expect(manifest.version).toBe(2);
    expect(posts.primaryKey).toBe("id");
    expect(posts.primaryKeyField).toBe("id");
    expect(posts.primaryKeyType).toBe("uuid");
    expect(posts.fields.find((field) => field.name === "id")).toMatchObject({
      system: true,
      generated: true,
      readonly: true,
      primaryKey: true,
      branded: "PostsId",
    });
    expect(posts.fields.find((field) => field.name === "created_at")).toMatchObject({
      system: true,
      generated: true,
      readonly: true,
      nullable: false,
    });
    expect(posts.fields.find((field) => field.name === "author_id")).toMatchObject({
      kind: "m2o",
      target: "authors",
      readonly: true,
      encrypted: true,
      nullable: true,
      system: false,
      branded: "AuthorsId",
    });
    expect(posts.relations).toEqual([
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
    ]);
  });
});

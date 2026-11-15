import { describe, expect, it } from "vitest";

import { generateTypes } from "../index";
import type { TypegenManifest } from "../types";

describe("generateTypes — geopoint (#746)", () => {
  it("types a geopoint field as { lat: number; lng: number }", () => {
    const manifest = {
      version: 2,
      site: "site_1",
      collections: [
        {
          name: "places",
          primaryKey: "id",
          primaryKeyField: "id",
          primaryKeyType: "nanoid",
          fields: [
            { name: "loc", type: "geopoint", required: true, nullable: false, system: false, readonly: false, generated: false, encrypted: false },
            { name: "alt_loc", type: "geopoint", required: false, nullable: true, system: false, readonly: false, generated: false, encrypted: false },
          ],
        },
      ],
      relations: [],
    } as unknown as TypegenManifest;
    const out = generateTypes(manifest);
    expect(out).toMatch(/\bloc: \{ lat: number; lng: number \}/);
    expect(out).toMatch(/alt_loc\?: \{ lat: number; lng: number \} \| null/);
  });
});

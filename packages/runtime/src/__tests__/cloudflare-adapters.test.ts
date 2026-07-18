import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CloudflareCacheProvider,
  type KVNamespace,
} from "../adapters/cloudflare/cache";
import {
  CloudflareStorageProvider,
  type R2Bucket,
} from "../adapters/cloudflare/storage";
import { CloudflareSearchProvider } from "../adapters/cloudflare/search";

// ─── Mock KVNamespace ────────────────────────────────────────────────────────

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expirationTtl?: number }>();

  return {
    get: vi.fn(async (key: string, _type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      try {
        return JSON.parse(entry.value);
      } catch {
        return entry.value;
      }
    }),
    put: vi.fn(
      async (
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ) => {
        store.set(key, { value, expirationTtl: options?.expirationTtl });
      },
    ),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

// ─── Mock R2Bucket ───────────────────────────────────────────────────────────

interface MockR2Object {
  key: string;
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

function createMockR2Bucket(): R2Bucket {
  const store = new Map<
    string,
    { data: Buffer; metadata?: Record<string, string>; httpMetadata?: { contentType?: string } }
  >();

  return {
    put: vi.fn(
      async (
        key: string,
        value: ReadableStream | ArrayBuffer | Buffer | string | null,
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
      ) => {
        let buffer: Buffer;
        if (Buffer.isBuffer(value)) {
          buffer = value;
        } else if (value instanceof ArrayBuffer) {
          buffer = Buffer.from(value);
        } else if (typeof value === "string") {
          buffer = Buffer.from(value);
        } else if (value === null) {
          buffer = Buffer.alloc(0);
        } else {
          // ReadableStream — collect chunks
          const reader = (value as ReadableStream).getReader();
          const chunks: Uint8Array[] = [];
          let done = false;
          while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) chunks.push(result.value);
          }
          buffer = Buffer.concat(chunks);
        }
        store.set(key, {
          data: buffer,
          metadata: options?.customMetadata,
          httpMetadata: options?.httpMetadata,
        });
      },
    ),
    get: vi.fn(async (key: string): Promise<MockR2Object | null> => {
      const entry = store.get(key);
      if (!entry) return null;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(entry.data);
          controller.close();
        },
      });
      return {
        key,
        body: stream,
        size: entry.data.length,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.metadata,
      };
    }),
    delete: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        store.delete(k);
      }
    }),
    list: vi.fn(
      async (options?: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) => {
        const prefix = options?.prefix ?? "";
        const matchingKeys = Array.from(store.keys()).filter((k) =>
          k.startsWith(prefix),
        );
        return {
          objects: matchingKeys.map((k) => ({ key: k })),
          truncated: false,
          cursor: undefined,
        };
      },
    ),
  } as unknown as R2Bucket;
}

// ─── CloudflareCacheProvider Tests ───────────────────────────────────────────

describe("CloudflareCacheProvider", () => {
  let kv: KVNamespace;
  let cache: CloudflareCacheProvider;

  beforeEach(() => {
    kv = createMockKV();
    cache = new CloudflareCacheProvider(kv);
  });

  describe("get", () => {
    it("should return null for a non-existent key", async () => {
      const result = await cache.get("missing-key");
      expect(result).toBeNull();
      expect(kv.get).toHaveBeenCalledWith("missing-key", "json");
    });

    it("should return the stored value for an existing key", async () => {
      await cache.set("my-key", JSON.stringify({ hello: "world" }));
      const result = await cache.get<{ hello: string }>("my-key");
      expect(result).toEqual({ hello: "world" });
    });

    it("should return a string value", async () => {
      await cache.set("str-key", JSON.stringify("simple-string"));
      const result = await cache.get("str-key");
      expect(result).toBe("simple-string");
    });
  });

  describe("set", () => {
    it("should store a value without TTL", async () => {
      await cache.set("key1", "value1");
      expect(kv.put).toHaveBeenCalledWith("key1", "value1", undefined);
    });

    it("should store a value with TTL", async () => {
      await cache.set("key2", "value2", { ttl: 300 });
      expect(kv.put).toHaveBeenCalledWith("key2", "value2", {
        expirationTtl: 300,
      });
    });

    it("should not pass expirationTtl when ttl is not provided in options", async () => {
      await cache.set("key3", "value3", {});
      expect(kv.put).toHaveBeenCalledWith("key3", "value3", undefined);
    });
  });

  describe("delete", () => {
    it("should delete an existing key", async () => {
      await cache.set("to-delete", "some-value");
      await cache.delete("to-delete");
      expect(kv.delete).toHaveBeenCalledWith("to-delete");
      const result = await cache.get("to-delete");
      expect(result).toBeNull();
    });

    it("should not throw when deleting a non-existent key", async () => {
      await expect(cache.delete("non-existent")).resolves.toBeUndefined();
    });
  });
});

// ─── CloudflareStorageProvider Tests ─────────────────────────────────────────

describe("CloudflareStorageProvider", () => {
  let bucket: R2Bucket;
  let storage: CloudflareStorageProvider;

  beforeEach(() => {
    bucket = createMockR2Bucket();
    storage = new CloudflareStorageProvider(bucket);
  });

  describe("put", () => {
    it("should store data without metadata", async () => {
      const data = Buffer.from("hello world");
      await storage.put("file.txt", data);
      expect(bucket.put).toHaveBeenCalledWith(
        "file.txt",
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        {},
      );
    });

    it("should store data with metadata", async () => {
      const data = Buffer.from("content");
      const metadata = { author: "test", type: "document" };
      await storage.put("doc.pdf", data, metadata);
      expect(bucket.put).toHaveBeenCalledWith(
        "doc.pdf",
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        { customMetadata: metadata },
      );
    });

    it("maps contentType onto native httpMetadata so it round-trips on get", async () => {
      const data = Buffer.from("img");
      await storage.put("photo.png", data, { contentType: "image/png" });
      expect(bucket.put).toHaveBeenCalledWith(
        "photo.png",
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        { customMetadata: { contentType: "image/png" }, httpMetadata: { contentType: "image/png" } },
      );

      const result = await storage.get("photo.png");
      expect(result!.contentType).toBe("image/png");
    });
  });

  describe("get", () => {
    it("should return null for a non-existent key", async () => {
      const result = await storage.get("missing-file");
      expect(result).toBeNull();
    });

    it("should return a StorageObject for an existing key", async () => {
      const data = Buffer.from("file content");
      await storage.put("existing.txt", data);

      const result = await storage.get("existing.txt");
      expect(result).not.toBeNull();
      expect(result!.key).toBe("existing.txt");
      expect(result!.size).toBe(data.length);
    });

    it("should return the correct body as a ReadableStream", async () => {
      const data = Buffer.from("stream content");
      await storage.put("stream.txt", data);

      const result = await storage.get("stream.txt");
      expect(result).not.toBeNull();

      // Read the stream
      const reader = (result!.body as ReadableStream).getReader();
      const { value } = await reader.read();
      expect(Buffer.from(value!)).toEqual(data);
    });

    it("should return metadata when stored", async () => {
      const data = Buffer.from("meta content");
      const metadata = { category: "images" };
      await storage.put("meta.txt", data, metadata);

      const result = await storage.get("meta.txt");
      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual(metadata);
    });
  });

  describe("delete", () => {
    it("should delete an existing object", async () => {
      const data = Buffer.from("to delete");
      await storage.put("delete-me.txt", data);
      await storage.delete("delete-me.txt");

      expect(bucket.delete).toHaveBeenCalledWith("delete-me.txt");
      const result = await storage.get("delete-me.txt");
      expect(result).toBeNull();
    });

    it("should not throw when deleting a non-existent key", async () => {
      await expect(storage.delete("non-existent")).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return an empty list when no objects exist", async () => {
      const result = await storage.list();
      expect(result).toEqual({ keys: [] });
    });

    it("should return all keys when no prefix is specified", async () => {
      await storage.put("a.txt", Buffer.from("a"));
      await storage.put("b.txt", Buffer.from("b"));
      await storage.put("c.txt", Buffer.from("c"));

      const result = await storage.list();
      expect(result.keys).toHaveLength(3);
      expect(result.keys).toContain("a.txt");
      expect(result.keys).toContain("b.txt");
      expect(result.keys).toContain("c.txt");
    });

    it("should filter keys by prefix", async () => {
      await storage.put("images/photo1.jpg", Buffer.from("p1"));
      await storage.put("images/photo2.jpg", Buffer.from("p2"));
      await storage.put("docs/readme.md", Buffer.from("readme"));

      const result = await storage.list("images/");
      expect(result.keys).toHaveLength(2);
      expect(result.keys).toContain("images/photo1.jpg");
      expect(result.keys).toContain("images/photo2.jpg");
    });

    it("should return empty list for a prefix with no matches", async () => {
      await storage.put("images/photo.jpg", Buffer.from("photo"));

      const result = await storage.list("videos/");
      expect(result).toEqual({ keys: [] });
    });

    it("should handle pagination (truncated results)", async () => {
      // Override the mock to simulate pagination
      const paginatedBucket = {
        ...bucket,
        list: vi
          .fn()
          .mockResolvedValueOnce({
            objects: [{ key: "file1.txt" }, { key: "file2.txt" }],
            truncated: true,
            cursor: "cursor-1",
          })
          .mockResolvedValueOnce({
            objects: [{ key: "file3.txt" }],
            truncated: false,
            cursor: undefined,
          }),
        put: bucket.put,
        get: bucket.get,
        delete: bucket.delete,
      } as unknown as R2Bucket;

      const paginatedStorage = new CloudflareStorageProvider(paginatedBucket);
      const result = await paginatedStorage.list();

      expect(result.keys).toEqual(["file1.txt", "file2.txt", "file3.txt"]);
      expect(paginatedBucket.list).toHaveBeenCalledTimes(2);
      // Second call should include the cursor
      expect(paginatedBucket.list).toHaveBeenCalledWith({
        prefix: undefined,
        cursor: "cursor-1",
        limit: 1000,
      });
    });
  });
});

describe("CloudflareSearchProvider — host normalization", () => {
  // `host` is private; read it via an index cast for the assertion.
  const hostOf = (h: string) =>
    (new CloudflareSearchProvider(h, "key") as unknown as { host: string }).host;

  it("strips a single trailing slash", () => {
    expect(hostOf("https://search.example.com/")).toBe("https://search.example.com");
  });

  it("strips many trailing slashes without a regex (ReDoS-proof)", () => {
    expect(hostOf("https://search.example.com/////")).toBe("https://search.example.com");
  });

  it("leaves a host with no trailing slash untouched", () => {
    expect(hostOf("https://search.example.com")).toBe("https://search.example.com");
  });

  it("does not strip slashes inside the host/path, only the tail", () => {
    expect(hostOf("https://h.example.com/base/")).toBe("https://h.example.com/base");
  });

  it("handles a pathological all-slashes / long input in linear time", () => {
    // A backtracking `/\/+$/` would stall here; the linear scan returns fast.
    const start = performance.now();
    expect(hostOf("/".repeat(100_000))).toBe("");
    expect(hostOf("https://h" + "/".repeat(100_000))).toBe("https://h");
    expect(performance.now() - start).toBeLessThan(100);
  });
});

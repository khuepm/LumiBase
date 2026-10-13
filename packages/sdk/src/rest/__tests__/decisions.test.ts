import { describe, expect, it } from "vitest";

import { createLumiClient, LumiError } from "../../client";
import { decide, type DecisionRequest, type DecisionResult } from "../decisions";

const request: DecisionRequest = {
  state: { title: "Khuyến mãi mùa hè", body: "Mua ngay!!!" },
  questions: {
    spam: {
      type: "noul",
      instructions: "Is this post spam?",
      criteria: { true: "spam", false: "legitimate" },
    },
    topic: {
      type: "choice",
      instructions: "Pick the topic",
      criteria: { promo: "Promotion", news: null },
    },
  },
};

const result: DecisionResult = {
  provider: "typesafe",
  model: "jev-1.13",
  calibrated: true,
  answers: {
    spam: { type: "noul", noul: 0.12 },
    topic: { type: "choice", choice: "promo", probabilities: { promo: 0.9, news: 0.1 }, confidence: 0.9 },
  },
  usage: { inputTokens: 42, outputTokens: 0 },
};

function client(fetcher: typeof fetch) {
  return createLumiClient({
    url: "https://api.example.test/",
    token: "dev:user",
    siteId: "site_1",
    fetcher,
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("decide", () => {
  it("POSTs the request to /api/v1/ai/decisions with bearer and site headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = client(async (url, init) => {
      calls.push({ url: String(url), init });
      return json(200, { data: result });
    });

    const data = await sdk.request(decide(request));

    expect(data).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/ai/decisions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer dev:user");
    expect(headers.get("x-lumi-site")).toBe("site_1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards the abort signal to fetch", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const sdk = client(async (_url, init) => {
      seen = init?.signal;
      return json(200, { data: result });
    });

    await sdk.request(decide(request, { signal: controller.signal }));

    expect(seen).toBe(controller.signal);
  });

  it("rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const sdk = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const pending = sdk.request(decide(request, { signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    [503, "DECISION_NOT_CONFIGURED"],
    [429, "DECISION_RATE_LIMITED"],
    [502, "DECISION_PARSE_FAILED"],
    [400, "VALIDATION"],
    [413, "DECISION_INPUT_TOO_LARGE"],
    [504, "DECISION_TIMEOUT"],
  ])("surfaces %i %s as LumiError", async (status, code) => {
    const sdk = client(async () => json(status, { errors: [{ code, message: "nope" }] }));

    const error = await sdk.request(decide(request)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LumiError);
    expect((error as LumiError).status).toBe(status);
    expect((error as LumiError).body.errors[0].code).toBe(code);
  });
});

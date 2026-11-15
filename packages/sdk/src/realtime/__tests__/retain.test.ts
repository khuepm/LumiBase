import { describe, expect, it, vi } from "vitest";

import { realtimeHolders, retainRealtime } from "../retain";

function fakeClient() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

describe("retainRealtime", () => {
  it("connects on the first hold and disconnects after the last release", () => {
    const rt = fakeClient();
    const a = retainRealtime(rt);
    const b = retainRealtime(rt);
    expect(rt.connect).toHaveBeenCalledTimes(1);
    expect(realtimeHolders(rt)).toBe(2);

    a();
    expect(rt.disconnect).not.toHaveBeenCalled();
    b();
    expect(rt.disconnect).toHaveBeenCalledTimes(1);
    expect(realtimeHolders(rt)).toBe(0);
  });

  it("ignores a second call of the same release function", () => {
    const rt = fakeClient();
    const a = retainRealtime(rt);
    const b = retainRealtime(rt);
    a();
    a();
    expect(rt.disconnect).not.toHaveBeenCalled();
    expect(realtimeHolders(rt)).toBe(1);
    b();
    expect(rt.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reconnects when held again after a full release", () => {
    const rt = fakeClient();
    retainRealtime(rt)();
    retainRealtime(rt);
    expect(rt.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps independent counts per client", () => {
    const one = fakeClient();
    const two = fakeClient();
    const releaseOne = retainRealtime(one);
    retainRealtime(two);
    releaseOne();
    expect(one.disconnect).toHaveBeenCalledTimes(1);
    expect(two.disconnect).not.toHaveBeenCalled();
  });
});

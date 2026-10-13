import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: () => ({ error: new Error("spawn npx ENOENT"), status: null }),
}));

const { initCommand } = await import("./init.js");
const { CliError } = await import("../errors.js");

describe("init when the package manager cannot be spawned", () => {
  it("points at the same pinned release, not @latest", () => {
    // During the 1.0 release candidates `latest` was the 0.x scaffolder with no
    // Next.js template, so a "run it directly" hint of `@latest` sent users to
    // a different product than the one `init` was about to run.
    let caught: unknown;
    try {
      initCommand([], { version: "1.0.0-rc.4", userAgent: "" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as InstanceType<typeof CliError>).hint).toBe(
      "Run `npm create lumibase@1.0.0-rc.4` directly.",
    );
  });
});

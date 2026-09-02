import { describe, expect, it } from "vitest";
import { initCommand, resolveScaffoldCommand } from "./init.js";

describe("resolveScaffoldCommand", () => {
  it("pins the scaffolder to the CLI version so both come from the same release", () => {
    expect(
      resolveScaffoldCommand("1.2.3", "npm/10.9.0 node/v22.0.0 darwin arm64"),
    ).toEqual({
      command: "npx",
      args: ["--yes", "create-lumibase@1.2.3"],
    });
  });

  it("uses the one-off runner of the package manager that invoked the CLI", () => {
    expect(
      resolveScaffoldCommand("1.2.3", "pnpm/9.12.0 npm/? node/v22.0.0"),
    ).toEqual({
      command: "pnpm",
      args: ["dlx", "create-lumibase@1.2.3"],
    });
    expect(
      resolveScaffoldCommand("1.2.3", "yarn/4.5.0 npm/? node/v22.0.0"),
    ).toEqual({
      command: "yarn",
      args: ["dlx", "create-lumibase@1.2.3"],
    });
    expect(
      resolveScaffoldCommand("1.2.3", "bun/1.1.30 npm/? node/v22.0.0"),
    ).toEqual({
      command: "bunx",
      args: ["create-lumibase@1.2.3"],
    });
  });

  it("falls back to npx for yarn classic, which has no dlx", () => {
    expect(
      resolveScaffoldCommand("1.2.3", "yarn/1.22.22 npm/? node/v22.0.0")
        .command,
    ).toBe("npx");
  });

  it("falls back to npx when no user agent is set", () => {
    expect(resolveScaffoldCommand("1.2.3", "").command).toBe("npx");
  });
});

describe("initCommand", () => {
  it("runs the scaffolder and forwards argv after the package spec", () => {
    const seen: { command?: string; args?: string[] } = {};

    const code = initCommand(["my-site", "--pm", "pnpm"], {
      version: "9.9.9",
      userAgent: "npm/10.9.0 node/v22.0.0",
      run: (command, args) => {
        seen.command = command;
        seen.args = args;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(seen.command).toBe("npx");
    expect(seen.args).toEqual([
      "--yes",
      "create-lumibase@9.9.9",
      "my-site",
      "--pm",
      "pnpm",
    ]);
  });

  it("defaults to this package version", () => {
    let spec: string | undefined;
    initCommand([], {
      userAgent: "",
      run: (_command, args) => {
        spec = args[1];
        return 0;
      },
    });
    expect(spec).toMatch(/^create-lumibase@\d+\.\d+\.\d+/);
  });

  it("propagates the scaffolder exit code", () => {
    expect(
      initCommand([], { version: "1.0.0", userAgent: "", run: () => 3 }),
    ).toBe(3);
  });
});

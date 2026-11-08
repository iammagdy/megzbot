import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/megzbot/dist-server/megzbot.js")).toBe("npx megzbot");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("megzbot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/megzbot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ OMB_CLI_PREFIX: "docker compose exec omb megzbot" }, "/app/dist-server/megzbot.js")).toBe("docker compose exec omb megzbot");
    expect(cliPrefix({}, "/usr/lib/node_modules/megzbot/dist-server/megzbot.js")).toBe("megzbot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\megzbot\\x.js")).toBe("npx megzbot pair");
  });
});

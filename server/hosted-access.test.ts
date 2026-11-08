// The HTTPS backchannel is injected, never redirected to a real portal.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { SessionRegistry } from "./sessions.ts";
import { HOSTED_CONTRACT_HEADER } from "./hosted-contract.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let PORT: number;
const HOST = "acme.example.test";
const EMAIL = "member@example.test";
const INSTANCES = { fixture: { driver: "hosted-access-test-shadow" }, claude: {
  driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
} };
let home: string;
let stateFile: string;
let child: ChildProcess;
let log = "";
let pairedToken: string;
let fixtureEnv: NodeJS.ProcessEnv;
let policyBotId: string | undefined;
const policyEvidence: unknown[] = [];
const state = (role: string | null = "admin", outage = false, license: { features?: string[]; expiresAt?: string; invalid?: boolean } = {}) => writeFileSync(stateFile, JSON.stringify({ role, outage, license }));

function call(path: string, options: { method?: string; cookie?: string; token?: string; local?: boolean; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any; cookies: string[]; location?: string; contractVersion?: string | string[] }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path, method: options.method ?? "GET", headers: {
      ...(options.local ? {} : { host: HOST, "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" }),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    } }, (res) => {
      let raw = ""; res.on("data", (chunk) => raw += chunk);
      res.on("end", () => { let body: unknown = raw; try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode!, body, cookies: res.headers["set-cookie"] ?? [], location: res.headers.location, contractVersion: res.headers[HOSTED_CONTRACT_HEADER] }); });
    });
    req.on("error", reject); req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
async function policyBot() {
  if (policyBotId) return policyBotId;
  const catalog = await call("/api/instances", { local: true });
  const provider = catalog.body.instances.find((instance: any) => instance.instanceId === "claude");
  expect(provider.driverKind).toBe("claudeAgent");
  expect(provider.snapshot.state).not.toBe("unavailable");
  expect(provider.cli).toBe(INSTANCES.claude.config.cli);
  const created = await call("/api/bots", { method: "POST", local: true, body: {
    name: "Hosted policy fixture", requireAvailableModel: true, modelSelection: { instanceId: "claude", model: provider.models.default },
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  // Everywhere else bots start at Full access; here Full comes only from the operator's policy.
  expect(created.body.bot.approvalMode).toBe("ask");
  return policyBotId = created.body.bot.id as string;
}
async function policyHealth(enabled: boolean, cookie?: string) {
  const health = await call("/api/health", cookie ? { cookie } : { local: true });
  expect(health.status).toBe(200);
  expect(health.body.capabilities.guardedFullAccess).toBe(1);
  expect(health.body.capabilities.sharedWorkspaceFullAccess).toBe(enabled ? 1 : undefined);
  policyEvidence.push({ health: health.body, authenticatedAs: cookie ? "portal session" : "loopback" });
}
async function refuseFullTask(cookie?: string) {
  const botId = await policyBot();
  const bots = async () => (await call("/api/bots?messages=0", { local: true })).body.bots;
  const before = (await bots()).find((bot: any) => bot.id === botId);
  const denied = await call(`/api/bots/${botId}/tasks`, { method: "POST", ...(cookie ? { cookie } : { local: true }),
    body: { title: "Must not become Full", approvalMode: "full" } });
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect((await bots()).find((bot: any) => bot.id === botId)).toEqual(before);
  policyEvidence.push({ deniedFullTask: denied.body, status: denied.status, authenticatedAs: cookie ? "portal session" : "loopback" });
}
async function restart(env: NodeJS.ProcessEnv = {}) {
  await waitForExit(child, { signal: "SIGTERM" });
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: { ...fixtureEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk); child.stderr?.on("data", (chunk) => log += chunk);
  await expect.poll(async () => {
    try { return (await call("/api/health", { local: true })).status; } catch { return 0; }
  }, { timeout: 20_000 }).toBe(200);
}

beforeAll(async () => {
  PORT = await freePortBlock([0, 1], 35_000, 5_000);
  home = mkdtempSync(join(tmpdir(), "omb-hosted-server-"));
  stateFile = join(home, "portal-fixture.json"); state();
  const data = join(home, ".megzbot");
  const layer = join(home, "enterprise");
  mkdirSync(join(layer, "server"), { recursive: true });
  mkdirSync(join(home, "static"));
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Fixture workspace</title>");
  const sessions = new SessionRegistry({ file: join(data, "sessions.json") });
  pairedToken = sessions.issue({ label: "Pre-existing QR device", scopes: ["admin", "client"] }).token;
  writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: [EMAIL] }, instances: INSTANCES }));
  writeFileSync(join(layer, "server", "index.ts"), `
    import { readFileSync } from 'node:fs';
    import { createWorkspaceAccess as create } from ${JSON.stringify(pathToFileURL(join(ROOT, "enterprise/server/workspace-access.ts")).href)};
    export function register() {
      const { license } = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
      if (license.invalid) throw new Error('invalid fixture license');
      return { customer: 'Fixture', features: license.features ?? ['admin'], expiresAt: license.expiresAt ?? null };
    }
    export function createWorkspaceAccess(options) {
      return create({ ...options, fetchImpl: async (url, init) => {
        if (new URL(url).origin !== 'https://admin.example.test') throw new Error('unexpected outbound origin');
        const current = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
        if (current.outage) throw new Error('offline fixture');
        const body = JSON.parse(init.body);
        if (body.workspace !== 'acme' || !current.role) return Response.json({}, { status: 401 });
        return Response.json({ email: ${JSON.stringify(EMAIL)}, role: current.role, grant: 'g'.repeat(43) });
      } });
    }
  `);
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: fixtureEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
    OMB_STATIC_DIR: join(home, "static"), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
    OMB_ENTERPRISE_DIR: layer, OMB_LICENSE_KEY: "fixture-only", OMB_ADMIN_URL: "https://admin.example.test",
    OMB_ADMIN_WORKSPACE: "acme", OMB_PUBLIC_URL: `https://${HOST}`,
    // These cases set fixtures up over loopback, so they keep the owner; the hosted default (service) has its own case.
    OMB_LOOPBACK_TRUST: "owner",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk); child.stderr?.on("data", (chunk) => log += chunk);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await call("/api/health", { local: true })).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned hosted fixture failed to start:\n${log}`);
}, 30_000);
afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  const evidenceDir = join(tmpdir(), "megzbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `hosted-access-${Date.now()}-${process.pid}.log`);
  writeFileSync(logPath, log);
  writeFileSync(`${logPath}.json`, JSON.stringify(policyEvidence, null, 2));
  console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.json` }));
  await removeTempDir(home);
});

describe("hosted bridge in the full server", () => {
  it("fails closed if a configured deployment loses its enterprise hook, with local owner access retained", async () => {
    await restart({ OMB_ENTERPRISE_DIR: join(home, "absent-layer"), OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" });
    await policyHealth(false);
    await refuseFullTask();
    expect((await call("/api/health/hosted")).status).toBe(503);
    expect((await call("/api/auth/hosted/start")).status).toBe(503);
    expect((await call("/")).status).toBe(503);
    expect((await call("/pair")).status).toBe(503);
    expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(503);
    expect((await call("/api/auth/email/verify", { method: "POST" })).status).toBe(403);
    expect((await call("/api/auth/session", { local: true })).body.kind).toBe("loopback");
  }, 25_000);
  it.each([
    ["standalone", { OMB_ADMIN_URL: undefined, OMB_ADMIN_WORKSPACE: undefined, OMB_ADMIN_MEMBERSHIP: undefined }],
    ["incomplete hosted configuration", { OMB_ADMIN_URL: undefined, OMB_ADMIN_MEMBERSHIP: "portal" }],
    ["invalid workspace", { OMB_ADMIN_WORKSPACE: "../private", OMB_ADMIN_MEMBERSHIP: "portal" }],
    ["invalid membership mode", { OMB_ADMIN_MEMBERSHIP: "invalid" }],
    ["local membership mode", { OMB_ADMIN_MEMBERSHIP: "local" }],
  ] satisfies [string, NodeJS.ProcessEnv][])("does not attest portal readiness for %s", async (_name, env) => {
    state();
    await restart(env);
    const readiness = await call("/api/health/hosted");
    expect(readiness.status).toBe(503);
    expect(readiness.contractVersion).toBeUndefined();
    expect(readiness.body).toEqual({ error: "Hosted workspace readiness is unavailable." });
    expect((await call("/api/health")).status).toBe(200);
  }, 25_000);
  it.each([
    ["invalid license", { invalid: true }, {}],
    ["missing admin entitlement", { features: [] }, {}],
    ["missing license", {}, { OMB_LICENSE_KEY: undefined }],
  ] satisfies [string, Parameters<typeof state>[2], NodeJS.ProcessEnv][])("does not attest portal readiness without valid admin entitlement (%s)", async (_name, license, env) => {
    state("admin", false, license);
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1", ...env });
    expect((await call("/api/health/hosted")).status).toBe(503);
    expect((await call("/api/health")).status).toBe(200);
    await policyHealth(false);
    await refuseFullTask();
  }, 25_000);
  it("never activates the shared Full policy in a desktop-managed process", async () => {
    state();
    await policyBot();
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1", OMB_DESKTOP_PARENT: "1" });
    await policyHealth(false);
    await refuseFullTask();
  }, 25_000);
});

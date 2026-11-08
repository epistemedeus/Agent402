#!/usr/bin/env node
// Boot the actual HTTP route-execute handler, resolver and payer with no buyer
// key. A disposable TLS seller handles only GET. The socket fixture translates
// a validated public test address to loopback after the dispatcher's lookup.
import "./lib/offline-stores.js";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
import { ownStoreEnv } from "./lib/own-stores.js";

const host = "seller.hosted-get.test";
const rebound = "rebound.hosted-get.test";
const origin = `https://${host}`;
const base = "eip155:8453";
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const payTo = "0x00000000000000000000000000000000000000aa";
const offer = { scheme: "exact", network: base, amount: "5000", asset, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
const extract = "/extract";
const audit = "/commerce/seller-integrity-audit";
const sample = "https://example.test/discovery-only";
const inputs = { [extract]: { url: sample }, [audit]: { origin: sample, route: "/example" } };
const changed = { url: "https://buyer.example/new?x=one&y=two" };
const changedAudit = { origin: "https://buyer.example", route: "/another" };
const logicalUrl = (path, query) => `${origin}${path}?${new URLSearchParams(query)}`;
const walletNotConfigured = /Upstream buyer wallet not configured/;

function catalogue(seller, routes) {
  return { x402Version: 2, items: routes.map(({ path, amount = "5000", network = base, query, method = "GET" }) => {
    const url = seller + path;
    const accept = { ...offer, amount, network };
    if (!query) return { resource: { url, serviceName: "canonical probe" }, request: { method }, accepts: [accept] };
    const exampleUrl = url + "?" + new URLSearchParams(query);
    return {
      resource: { url: exampleUrl, routeTemplate: path, serviceName: "canonical probe" },
      request: { url, method, exampleUrl, example: { type: "http", method, queryParams: query },
        schema: { properties: { queryParams: { type: "object", required: Object.keys(query),
          properties: Object.fromEntries(Object.keys(query).map((key) => [key, { type: "string" }])) } } } },
      accepts: [accept],
    };
  }) };
}

async function installFixture() {
  const networkFetch = globalThis.fetch;
  await import("./offline-egress-preload.js");
  if (!isMainThread) return;
  const offlineFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const dns = require("node:dns");
  const dnsPromises = require("node:dns/promises");
  const tls = require("node:tls");
  const net = require("node:net");
  const lookup = dns.lookup, lookupAsync = dnsPromises.lookup, connect = tls.connect;
  const fakePublic = "93.184.215.14";
  const isFixture = (name) => name === host || name === rebound;
  globalThis.fetch = (url, opts) => {
    if (!isFixture(new URL(typeof url === "string" ? url : url?.url || String(url)).hostname)) return offlineFetch(url, opts);
    assert.ok(opts?.dispatcher, "the preflight uses the pinned dispatcher");
    assert.equal(opts.redirect, "manual", "the preflight refuses redirects");
    return networkFetch(url, opts);
  };
  const events = process.env.HOSTED_GET_EVENTS;
  const sellerPort = Number(process.env.HOSTED_GET_SELLER_PORT);
  const report = (event) => process.stdout.write(`fixture:${JSON.stringify(event)}\n`);
  dnsPromises.lookup = (name, opts) => isFixture(name) ? Promise.resolve({ address: fakePublic, family: 4 }) : lookupAsync(name, opts);
  dns.lookup = (name, opts, cb) => {
    if (!isFixture(name)) return lookup(name, opts, cb);
    const address = name === rebound ? "127.0.0.1" : fakePublic;
    process.nextTick(cb, null, opts.all ? [{ address, family: 4 }] : address, 4);
  };
  tls.connect = (opts, ...rest) => {
    if (!isFixture(opts?.host)) return connect(opts, ...rest);
    assert.equal(typeof opts.lookup, "function", "the guarded dispatcher supplies the connect lookup");
    const socket = net.connect({
      host: "localhost", port: sellerPort, family: 4,
      lookup(_name, _opts, done) {
        opts.lookup(opts.host, { family: 4 }, (err, address) => {
          report({ kind: "lookup", host: opts.host, refused: Boolean(err) });
          if (err) return done(err);
          assert.equal(address, fakePublic, "only the fixture's guarded address can map to loopback");
          done(null, "127.0.0.1", 4);
        });
      },
    });
    return connect({ ...opts, socket }, ...rest);
  };
  syncBuiltinESMExports();

  const { __testSeedCache, normaliseManifestTools, normaliseOpenapiTools, mergeManifestIntoTools } = await import("../src/x402-index.js");
  const { setTrajectoryListenerForTest } = await import("../src/tools/route-execute.js");
  const { routerPoolStatus } = await import("../src/router-pool.js");
  const fixtureRows = [
    [origin, [
      { path: extract, query: inputs[extract] }, { path: audit, query: inputs[audit], amount: "10000" },
      { path: "/sku?tier=premium" }, { path: "/other-chain", query: { url: sample }, network: "eip155:137" },
      { path: "/too-expensive", query: { url: sample }, amount: "30000" },
      { path: "/unapproved-post", method: "POST" },
      { path: "/legacy-binding", query: { url: sample } },
      { path: "/mismatched-contract", query: { url: sample } },
    ]],
    [`https://${rebound}`, [{ path: "/rebind", query: { url: sample } }]],
    [`https://127.0.0.1:${sellerPort}`, [{ path: "/private", query: { url: sample } }]],
  ];
  __testSeedCache(fixtureRows.map(([seller, routes]) => {
    const manifest = catalogue(seller, routes);
    const openapi = { openapi: "3.1.0", paths: Object.fromEntries(routes.filter((r) => r.query).map(({ path }) => [
      path, { get: { summary: "canonical probe", responses: { 200: { description: "OK" } },
        ...(path === "/mismatched-contract" ? { parameters: [{ name: "other", in: "query", required: true }] } : {}) } },
    ])) };
    const tools = mergeManifestIntoTools(normaliseManifestTools(manifest, seller), normaliseOpenapiTools(openapi, seller));
    if (seller === origin) {
      // Older cache rows held only a boolean, and a non-GET marker must never
      // cause the resolver to send a request under the canonical binding.
      const canonical = tools.find((row) => row.route === extract);
      tools.find((row) => row.route === "/legacy-binding").manifestCanonicalRequest = true;
      tools.find((row) => row.route === "/unapproved-post").manifestCanonicalRequest = canonical.manifestCanonicalRequest;
    }
    return [seller, { manifest: { name: "fixture seller" }, tools, fetchedAt: Date.now(), history: [1], originResponded: true }];
  }));
  if (process.env.ROUTER_WORKERS === "1") {
    const ready = setInterval(() => {
      if (!routerPoolStatus().loaded) return;
      clearInterval(ready);
      report({ kind: "worker-ready" });
    }, 25);
    ready.unref();
  }
  setTrajectoryListenerForTest((req, step, data) => {
    if (req?.headers?.["x-hosted-fixture"] === events && step === "attempt") report({ kind: "payer", workerQueries: routerPoolStatus().served.worker, ...data });
  });
}

async function run() {
  const tmp = mkdtempSync(join(tmpdir(), "agent402-hosted-get-"));
  const stores = ownStoreEnv("hosted-get");
  const key = join(tmp, "tls.key"), cert = join(tmp, "tls.crt");
  const seen = [], trace = [];
  let child, server, log = "";
  const workers = process.env.HOSTED_GET_WORKERS === "1" ? "1" : "0";
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`,
      "-addext", `subjectAltName=DNS:${host},DNS:${rebound}`], { stdio: "ignore" });
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const mode = url.searchParams.get("url")?.split("/").at(-1);
      const reply = (status, headers = {}) => {
        seen.push({ method: req.method, url: url.href, headers: req.headers, status });
        res.writeHead(status, headers).end();
      };
      if (req.method !== "GET") return reply(405);
      const required = Object.keys(inputs[path] || {});
      if (required.some((name) => url.searchParams.getAll(name).length !== 1)) return reply(400);
      if (mode === "rejected") return reply(422);
      if (mode === "redirect") return reply(302, { location: "http://127.0.0.1:1/escape" });
      if (mode === "invalid") return reply(402, { "payment-required": "unparseable" });
      const accepts = [{ ...offer, amount: path === audit ? "10000" : "5000" }];
      if (mode === "wrong-chain") accepts[0].network = "eip155:137";
      if (mode === "wrong-asset") accepts[0].asset = payTo;
      if (mode === "bad-payee") accepts[0].payTo = "invalid";
      if (mode === "bad-validity") accepts[0].maxTimeoutSeconds = 0.5;
      if (mode === "over-cap") accepts[0].amount = "10001";
      if (mode === "split") accepts[0].maxAmountRequired = "1";
      if (mode === "wrong-domain") accepts[0].extra = { name: "USDC", version: "2" };
      const resource = { url: mode === "example-challenge" ? logicalUrl(extract, inputs[extract]) : url.href };
      return reply(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource, accepts })).toString("base64") });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sellerPort = server.address().port;
    child = spawn(process.execPath, ["--import", "./scripts/test-hosted-get-resolver.js", "src/server.js"], {
      cwd: new URL("..", import.meta.url),
      env: { ...stores, PATH: process.env.PATH, NODE_ENV: "test", NETWORK: "base", FREE_MODE: "true",
        PORT: "0", SOR_EXTERNAL_ENABLED: "true", SOR_BASE_UNPROVEN_MAX_USD: "0.02", ROUTE_JUDGE: "off",
        X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", ROUTER_WORKERS: workers,
        LEADERBOARD_FUNDING_SCAN: "off", MONITOR_SCHEDULER: "off", LOAD_SHED: "off",
        NODE_EXTRA_CA_CERTS: cert, HOSTED_GET_SELLER_PORT: String(sellerPort), HOSTED_GET_EVENTS: "active" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (buf) => { log += buf; });
    child.stderr.on("data", (buf) => { log += buf; });
    let port;
    for (let i = 0; i < 180 && child.exitCode === null; i++) {
      port = log.match(/listening on :(\d+)/)?.[1];
      if (port && (workers === "0" || log.includes('"worker-ready"'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(port, "the hosted server started");
    const app = `http://127.0.0.1:${port}`;
    const call = async (target, params, maxUsd = 0.02) => {
      seen.length = trace.length = 0;
      const r = await fetch(app + "/api/route/execute-plus", {
        method: "POST", headers: { "content-type": "application/json", "x-hosted-fixture": "active" },
        body: JSON.stringify({ task: "canonical probe", include: "external", target, params, maxUsd }),
      });
      const body = await r.text();
      for (const line of log.split("\n")) if (line.startsWith("fixture:")) trace.push(JSON.parse(line.slice(8)));
      log = log.split("\n").filter((line) => !line.startsWith("fixture:")).join("\n");
      return { status: r.status, body, probes: [...seen], events: [...trace] };
    };
    const publicRows = await (await fetch(app + "/api/route?q=canonical%20probe&include=external")).json();
    assert.ok(publicRows.results.some((r) => r.route === extract && r.requestContract?.required?.query?.includes("url")));
    assert.ok(publicRows.results.every((r) => !Object.hasOwn(r, "canonicalGetBinding")), "binding stays off the public API");

    let guardedConnection = false;
    for (const [path, params] of [[extract, changed], [audit, changedAudit]]) {
      const result = await call(origin + path, params);
      const expected = logicalUrl(path, params);
      assert.deepEqual(result.probes.map((p) => [p.url, p.status]), [[expected, 402]],
        `hosted resolver must preflight the constructed request for ${path}`);
      assert.equal(result.probes[0].method, "GET");
      assert.ok(!Object.keys(result.probes[0].headers).some((key) => /^(payment|x-payment|authorization)/i.test(key)));
      assert.match(result.body, walletNotConfigured, "the real payer stopped before loading a signer");
      assert.deepEqual(result.events.filter((e) => e.kind === "payer").map((e) => e.url), [expected],
        "the exact preflight URL reached the payer boundary");
      guardedConnection ||= result.events.some((e) => e.kind === "lookup" && !e.refused);
      if (workers === "1") assert.ok(result.events.some((e) => e.kind === "payer" && e.workerQueries > 0));
      console.log(`ok - ${path} preflight and unsigned payer target match`);
    }
    assert.ok(guardedConnection, "the guarded connection resolved");
    const rejected = async (name, target, params, expectedProbes, maxUsd) => {
      const result = await call(target, params, maxUsd);
      assert.deepEqual(result.probes.map((p) => p.status), expectedProbes, name);
      assert.ok(result.events.every((e) => e.kind !== "payer"), name + " never reaches the payer");
      assert.ok(result.probes.every((p) => p.method === "GET"
        && !Object.keys(p.headers).some((key) => /^(payment|x-payment|authorization)/i.test(key))), name + " stays unsigned");
      console.log(`ok - ${name}`);
      return result;
    };
    await rejected("missing required input", origin + extract, {}, []);
    await rejected("nested input", origin + extract, { url: { value: sample } }, []);
    await rejected("undeclared input", origin + extract, { ...changed, other: "unbound" }, []);
    await rejected("blank input", origin + extract, { url: "  " }, []);
    await rejected("oversized input", origin + extract, { url: "a".repeat(8200) }, []);
    await rejected("legacy marker lacks a validated binding", origin + "/legacy-binding", changed, []);
    await rejected("conflicting OpenAPI required fields", origin + "/mismatched-contract", changed, []);
    await rejected("a non-GET cannot use the binding or send a POST", origin + "/unapproved-post", changed, []);
    await rejected("prepopulated target is not the pinned canonical operation", logicalUrl(extract, inputs[extract]), changed, []);
    await rejected("wrong indexed chain", origin + "/other-chain", changed, []);
    await rejected("listing exceeds the requested cap", origin + audit, changedAudit, [], 0.006);
    await rejected("existing settlement gate rejects the candidate", origin + "/too-expensive", changed, [], 0.04);
    for (const mode of ["invalid", "wrong-chain", "wrong-asset", "bad-payee", "bad-validity", "over-cap", "split", "wrong-domain", "example-challenge", "rejected", "redirect"]) {
      await rejected(mode, origin + extract, { url: `https://buyer.example/${mode}` },
        [mode === "rejected" ? 422 : mode === "redirect" ? 302 : 402], 0.008);
    }
    await rejected("private address guard", `https://127.0.0.1:${sellerPort}/private`, changed, []);
    const rebinding = await rejected("connect-time rebinding guard", `https://${rebound}/rebind`, changed, []);
    assert.ok(rebinding.events.some((e) => e.kind === "lookup" && e.host === rebound && e.refused));
    const literal = origin + "/sku?tier=premium";
    await rejected("literal query conflict", literal, { tier: "basic" }, [402]);
    const fixed = await call(literal, { tier: "premium" });
    assert.deepEqual(fixed.probes.map((p) => p.url), [literal]);
    assert.match(fixed.body, walletNotConfigured);
    console.log("ok - literal query variant keeps its original preflight");
  } catch (error) {
    console.error(log.split("\n").slice(-20).join("\n"));
    throw error;
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    server?.closeAllConnections();
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dirname(stores.INDEX_CACHE_FILE), { recursive: true, force: true });
  }
}

if (process.env.HOSTED_GET_EVENTS) await installFixture();
else await run();

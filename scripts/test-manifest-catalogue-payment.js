#!/usr/bin/env node
// A seller can publish their payment terms INSIDE a catalogue entry. Three
// such shapes are live right now, and the catalogue reader took the entry's
// URL, name, description and price string and dropped everything about money:
//
//   resources: [{ resource, accepts: [{network, asset, payTo, …}] }]   nested
//   resources: [{ resource, scheme, network, asset, payTo, amount }]   flat
//   payment:   { network, asset_address, pay_to, … }                   service-wide
//
// The row came out with networks: [], so the seller's `networks` aggregate was
// empty and dispatch eligibility read `network_unknown`: on the marketplace,
// invisible to the router and to its own chain page. Same defect class as the
// single-resource manifest (scripts/test-single-resource-manifest.js) and the
// same cost — listed and unroutable is worse than absent, it looks like it
// worked.
//
// Measured against the live index 2026-09-15: 304 sellers labelled
// `network_unknown`, 83 still serving a manifest, and 59 of those 83 declaring
// a chain in one of these three shapes — 49 of them eip155:8453. The fixtures
// below are the exact shapes of three of them, with addresses replaced.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { dispatchEligibility } from "../src/dispatch-eligibility.js";
import { carryForwardLearnedQuotes, mergeManifestIntoTools, normaliseManifestTools, stampDeclared } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x00000000000000000000000000000000000000aa";

// --- shape 1: flat payment fields on the catalogue entry --------------------
{
  const ORIGIN = "https://flat.example";
  const tools = normaliseManifestTools({
    resources: [{
      scheme: "exact", network: BASE, maxAmountRequired: "100000", amount: "100000",
      resource: `${ORIGIN}/v1/topup`, description: "Top up credits.",
      mimeType: "application/json", payTo: PAYTO, asset: USDC,
      extra: { name: "USD Coin", version: "2" },
    }],
  }, ORIGIN);
  ok(tools.length === 1, `flat: ${tools.length} tools, want 1`);
  const t = tools[0] || {};
  ok(JSON.stringify(t.networks) === `["${BASE}"]`, `flat networks ${JSON.stringify(t.networks)} — this is the router-invisible case`);
  ok(t.payToByNetwork?.[BASE] === PAYTO, `flat payTo ${JSON.stringify(t.payToByNetwork)}`);
  ok(t.price === "$0.1", `flat price ${t.price} (100000 atomic USDC is $0.1)`);
  ok(t.evmDomainByNetwork?.[BASE]?.name === "USD Coin", `flat EIP-712 domain ${JSON.stringify(t.evmDomainByNetwork)}`);
}

// --- shape 2: accepts nested inside the catalogue entry ---------------------
{
  const ORIGIN = "https://nested.example";
  const tools = normaliseManifestTools({
    x402Version: 2,
    resources: [{
      resource: `${ORIGIN}/service`,
      accepts: [{
        scheme: "exact", network: BASE, asset: USDC, maxAmountRequired: "30000",
        resource: `${ORIGIN}/service`, description: "Pre-trade go/no-go verdict.",
        mimeType: "application/json", payTo: PAYTO, maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      }],
    }],
  }, ORIGIN);
  ok(tools.length === 1, `nested: ${tools.length} tools, want 1`);
  const t = tools[0] || {};
  ok(JSON.stringify(t.networks) === `["${BASE}"]`, `nested networks ${JSON.stringify(t.networks)}`);
  ok(t.payToByNetwork?.[BASE] === PAYTO, `nested payTo ${JSON.stringify(t.payToByNetwork)}`);
  ok(t.price === "$0.03", `nested price ${t.price} — maxAmountRequired is the v1 spelling and must be read`);
}

// --- shape 3: one service-wide payment block, many routes -------------------
{
  const ORIGIN = "https://service.example";
  const tools = normaliseManifestTools({
    x402Version: 2,
    service: { name: "Tech Detect", base_url: ORIGIN },
    payment: {
      protocol: "x402", scheme: "exact", network: "base", network_name: "Base Mainnet",
      chain_id: 8453, asset: "USDC", asset_address: USDC, pay_to: PAYTO,
    },
    endpoints: [
      { path: "/stack", method: "POST", name: "Detect stack", price: "$0.01" },
      { path: "/stack/bulk", method: "POST", name: "Detect in bulk", price: "$0.05" },
    ],
  }, ORIGIN);
  ok(tools.length === 2, `service-wide: ${tools.length} tools, want 2`);
  for (const t of tools) {
    ok(JSON.stringify(t.networks) === `["${BASE}"]`,
      `service-wide ${t.route}: networks ${JSON.stringify(t.networks)} — "base" must normalise to CAIP-2`);
    ok(t.payToByNetwork?.[BASE] === PAYTO, `service-wide ${t.route}: payTo ${JSON.stringify(t.payToByNetwork)}`);
  }
  ok(tools[0].price === "$0.01" && tools[1].price === "$0.05",
    `service-wide prices ${tools.map((t) => t.price).join(",")} — the entry's own price must survive`);
}

// --- a thin sibling on the same path inherits the chain ---------------------
{
  const ORIGIN = "https://sibling.example";
  const tools = normaliseManifestTools({
    resources: [`GET /ip-geo`, { resource: `${ORIGIN}/ip-geo`, method: "POST", network: BASE, payTo: PAYTO, asset: USDC, amount: "1000" }],
  }, ORIGIN);
  ok(tools.length === 2, `sibling: ${tools.length} tools, want 2`);
  const get = tools.find((t) => t.method === "GET") || {};
  ok(JSON.stringify(get.networks) === `["${BASE}"]`,
    `sibling GET networks ${JSON.stringify(get.networks)} — one path, one set of payment terms`);
}

// --- a manifest that declares nothing stays as it was -----------------------
{
  const ORIGIN = "https://silent.example";
  const tools = normaliseManifestTools({ resources: [`POST /a`, `POST /b`] }, ORIGIN);
  ok(tools.length === 2, `silent: ${tools.length} tools, want 2`);
  ok(tools.every((t) => !(t.networks || []).length), "a manifest that says nothing about money must not gain a chain");
  ok(tools.every((t) => t.price === null), "a manifest that names no price must not gain one");
}

// A catalogue row with only a bare `amount`, under a manifest whose accepts
// name USDC by contract address, is quoting base units (0.10 USDC), not $100000.
{
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const manifest = {
    x402Version: 2, network: "base", payTo: "0x" + "c3".repeat(20),
    accepts: [{ scheme: "exact", network: "base", amount: "100000", asset: USDC_BASE, payTo: "0x" + "c3".repeat(20) }],
    services: [{ method: "POST", path: "/check", name: "check", amount: "100000" }],
  };
  const [row] = normaliseManifestTools(manifest, "https://seller.example");
  ok(row?.price === "$0.1", `a bare amount under an accepts block with an asset address reads as base units (got ${row?.price})`);
  // Without payment context anywhere, a bare amount still means dollars.
  const plain = normaliseManifestTools({ services: [{ method: "POST", path: "/check", name: "check", amount: "2" }] }, "https://seller.example");
  ok(plain[0]?.price === "$2", `a bare amount with no payment context anywhere stays dollars (got ${plain[0]?.price})`);
  // A row's own dollar field wins over the manifest context.
  const own = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount: "100000", price: "$0.25" }] }, "https://seller.example");
  ok(own[0]?.price === "$0.25", `a row's own price field is kept (got ${own[0]?.price})`);
  // A small whole figure stays dollars: 1 and "5" read as $1 and $5, never
  // $0.000001; a row with a unit or currency label is left to its own reading.
  for (const [amount, want] of [[1, "$1"], ["5", "$5"], [999, "$999"], [1000, "$0.001"], ["1000", "$0.001"], ["5000", "$0.005"]]) {
    const r = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount }] }, "https://seller.example");
    ok(r[0]?.price === want, `bare amount ${JSON.stringify(amount)} under base-unit accepts reads ${want} (got ${r[0]?.price})`);
  }
  const labelled = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount: 100000, unit: "usd" }] }, "https://seller.example");
  ok(labelled[0]?.price !== "$0.1", `a row with a unit label is not reread as base units (got ${labelled[0]?.price})`);
  // A ticker in the manifest accepts is not payment context.
  const ticker = normaliseManifestTools({ accepts: [{ network: "base", asset: "USDC", amount: "2" }], services: [{ method: "POST", path: "/check", name: "check", amount: "2" }] }, "https://seller.example");
  ok(ticker[0]?.price === "$2", `a ticker-only manifest accept leaves a bare amount as dollars (got ${ticker[0]?.price})`);
}

// A paths-manifest entry that lists its own `parameters` is still an x402
// entry; only verb keys and $ref mark an OpenAPI path item.
{
  const rows = normaliseManifestTools({ paths: { "/q": { methods: ["GET"], parameters: [{ name: "q" }], payment: { networks: ["eip155:8453"], payTo: "0x" + "ab".repeat(20) } } } }, "https://seller.example");
  ok(rows.length === 1 && (rows[0].networks || []).includes("eip155:8453"), `a paths entry with parameters is read (${rows.length} rows)`);
  const oa = normaliseManifestTools({ paths: { "/q": { get: { responses: {} }, parameters: [] } } }, "https://seller.example");
  ok(oa.every((r) => !(r.networks || []).length), "an OpenAPI path item keyed by verb is not read as a paths entry");
}

// An x402 v2 items catalogue describes each paid operation separately.
{
  const origin = "https://items.example";
  const get = "/extract?url=https%3A%2F%2Fexample.com";
  const post = "/extract/batch";
  const audit = "/commerce/seller-integrity-audit?method=GET&route=%2Fpreflight";
  const accept = { scheme: "exact", network: BASE, asset: USDC, amount: "5000", payTo: PAYTO };
  const entry = (route, method, terms = [accept]) => ({
    type: "http",
    resource: { url: `${origin}${route}`, description: "Describe the operation.", serviceName: "Example API" },
    request: { method },
    accepts: terms,
  });
  const manifest = { x402Version: 2, items: [
    entry(get, "GET"), entry(post, "POST", [{ ...accept, amount: "10000" }]),
    entry(audit, "GET", [{ ...accept, amount: "10000" }]),
  ] };
  const rows = normaliseManifestTools(manifest, origin);
  const summary = (list) => list.map((r) => [r.method, r.route, r.price, r.networks, r.payToByNetwork?.[BASE]]);
  const expected = [
    ["GET", get, "$0.005", [BASE], PAYTO],
    ["POST", post, "$0.01", [BASE], PAYTO],
    ["GET", audit, "$0.01", [BASE], PAYTO],
  ];
  ok(JSON.stringify(summary(rows)) === JSON.stringify(expected),
    `items: expected exact Base GET and POST declarations, got ${JSON.stringify(summary(rows))}`);
  ok(rows.length === 3 && rows.every((r) => r.provenance === "manifest" && !r.methodInferred
    && !r.quality && !r.quoteSource && !r.networksVerifiedAt && r.originDeclaredPrice === Number(r.price.slice(1))),
    "items: explicit verb and origin price without registry or live evidence");
  const dispatch = rows[0] && dispatchEligibility({ routable: true, networks: rows[0].networks, priceUsd: 0.005 });
  ok(dispatch?.reason === "settlement_required" && dispatch.eligible === false && dispatch.basis.settled === 0,
    "items: an advertised Base price adds no settlement evidence");

  const other = "eip155:137";
  const unknown = "eip155:999999";
  const otherPayTo = "0x00000000000000000000000000000000000000bb";
  const unknownAsset = "0x00000000000000000000000000000000000000cc";
  const variant = "/extract?url=https%3A%2F%2Fexample.net";
  const variants = normaliseManifestTools({ ...manifest, items: [
    entry(get, "GET"),
    entry(get, "POST", [{ ...accept, network: unknown, asset: unknownAsset, payTo: otherPayTo }]),
    entry(variant, "GET", [{ ...accept, network: other, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", amount: "9000", payTo: otherPayTo }]),
    entry(get, "GET", [{ ...accept, network: other, payTo: otherPayTo, amount: "4000" }]),
  ] }, origin);
  ok(variants.length === 3 && variants[0]?.price === "$0.005" && variants[0]?.networks?.join() === BASE
    && variants[0]?.payToByNetwork?.[BASE] === PAYTO,
    "items: first valid duplicate owns the exact key");
  ok(variants[1]?.price === null && variants[1]?.networks?.join() === unknown && variants[1]?.payToByNetwork?.[unknown] === otherPayTo
    && !variants[1]?.payToByNetwork?.[BASE], "items: an unknown chain and asset gain neither Base nor its price");
  ok(variants[2]?.route === variant && variants[2]?.price === "$0.009" && variants[2]?.networks?.join() === other
    && variants[2]?.payToByNetwork?.[other] === otherPayTo, "items: the query variant keeps its own terms");

  const invalid = [
    null, {}, entry("/bad-method", "BREW"), entry("/array-method", ["GET"]), entry("/missing-method", undefined),
    entry("/missing-accepts", "POST", null), entry("/empty-accepts", "GET", []),
    entry("/object-network", "GET", [{ ...accept, network: {} }]),
    entry("/unqualified-network", "GET", [{ ...accept, network: "not-a-chain" }]),
    entry("/bad-payto", "GET", [{ ...accept, payTo: "not-an-address" }]),
    entry("/bad-asset", "GET", [{ ...accept, asset: "not-a-contract" }]),
    entry("/fraction", "GET", [{ ...accept, amount: "0.005" }]),
    entry("/exponent", "GET", [{ ...accept, amount: "5e3" }]),
    entry("/overflow", "GET", [{ ...accept, amount: "9007199254740992" }]),
    entry("/conflicting-amounts", "GET", [{ ...accept, maxAmountRequired: "9999" }]),
    entry(`/oversize?q=${"a".repeat(8192)}`, "GET"),
    entry("/unsupported-scheme", "GET", [{ ...accept, scheme: "upto" }]),
    { ...entry("/bad-url", "GET"), resource: { url: {} } },
    ...["https://other.example/a", "http://items.example/a", "https://items.example:8080/a",
      "https://user@items.example/a", "https://items.example//other.example/a"].map((url) => ({
      ...entry("/bad-url", "GET"), resource: { url },
    })),
  ];
  ok(normaliseManifestTools({ ...manifest, payment: { network: BASE, payTo: PAYTO }, items: invalid }, origin).length === 0,
    "items: malformed rows, malformed terms and out-of-origin URLs are refused without a service-wide fallback");
  ok(normaliseManifestTools({ ...manifest, items: Array(1000).fill(null).concat(manifest.items) }, origin).length === 0,
    "items: the first 1,000 entries bound the catalogue");
  const badAccept = { ...accept, amount: "not-an-integer" };
  ok(normaliseManifestTools({ ...manifest, items: [
    entry("/too-many", "GET", Array(16).fill(badAccept).concat(accept)),
    entry("/partially-valid", "GET", [badAccept, accept]),
  ] }, origin).map((r) => r.route).join() === "/partially-valid",
  "items: invalid accepts are ignored and only the first 16 are examined");
  const scoped = normaliseManifestTools({ ...manifest, items: [entry("/scope/x?q=1", "GET"), entry("/scope-other/x", "GET")] }, `${origin}/scope`);
  ok(scoped.length === 1 && scoped[0].route === "/x?q=1", "items: scope is enforced at the seller's path boundary");
  const scopedCollision = normaliseManifestTools({
    ...manifest, origin: `${origin}/scope`, resources: ["/x?q=1"],
    items: [entry("/scope/x?q=1", "GET")],
  }, `${origin}/scope`);
  ok(scopedCollision.length === 1 && scopedCollision[0].price === "$0.005",
    "items: a re-anchored flat route collides on its final exact key");

  const mixed = normaliseManifestTools({ ...manifest, resources: [
    get, { resource: get, method: "POST" }, { resource: "/extract", method: "GET" },
    { resource: post, method: "POST", price: "$0.02" },
  ] }, origin);
  const mixedGet = mixed.find((r) => r.route === get && r.method === "GET");
  const mixedPost = mixed.find((r) => r.route === post && r.method === "POST");
  ok(mixed.length === 5 && mixedGet?.price === "$0.005" && !mixedGet.methodInferred
    && mixedPost?.price === "$0.02" && mixedPost?.networks?.join() === BASE,
    "items: exact collisions fill blanks, preserve an existing explicit price, and replace an inferred verb");
  ok(mixed.filter((r) => (r.method === "POST" && r.route === get) || r.route === "/extract")
    .every((r) => !r.price && !r.networks?.length && !r.payToByNetwork?.[BASE]),
    "items: a flat sibling method or query does not inherit item payment");

  const observed = [
    { method: "GET", route: get, price: 0.004, networks: [BASE], payToByNetwork: { [BASE]: otherPayTo }, quoteSource: "live-402" },
    { method: "POST", route: get, price: null },
    { method: "GET", route: "/extract", price: null },
    { method: "POST", route: post, price: null },
  ];
  const merged = mergeManifestIntoTools(rows, observed);
  stampDeclared(merged, rows);
  ok(merged.length === 5 && merged[0].price === 0.004 && merged[0].payToByNetwork[BASE] === otherPayTo
    && merged[3].price === "$0.01" && merged[3].payToByNetwork?.[BASE] === PAYTO && merged[3].declared,
    "items: exact OpenAPI or registry collisions enrich in place and preserve an observed quote");
  ok([merged[1], merged[2]].every((r) => r.declared === false && r.price === null && !r.networks?.length && !r.payToByNetwork?.[BASE]),
    "items: the crawl merge does not enrich or declare a different method or query");
  const exactPost = variants[1];
  if (exactPost) carryForwardLearnedQuotes([exactPost], { tools: [{ ...observed[0], quoteObservedAt: Date.now() }] });
  ok(exactPost?.price === null && exactPost?.method === "POST" && exactPost?.networks?.join() === unknown
    && !exactPost?.payToByNetwork?.[BASE], "items: a remembered GET quote cannot price or rechain a POST");

  const single = { x402Version: 2, resource: { url: `${origin}/single` }, accepts: [accept] };
  ok(normaliseManifestTools({ ...single, items: invalid }, origin)[0]?.route === "/single",
    "items: an unusable catalogue leaves the single-resource fallback intact");
  ok(!normaliseManifestTools({ ...single, items: manifest.items }, origin).some((r) => r.route === "/single"),
    "items: a usable catalogue takes precedence over the single-resource fallback");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

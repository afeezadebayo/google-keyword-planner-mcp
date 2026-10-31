// Smoke test: runs the built server against a mock Google Ads API and checks every tool.
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const seen = [];
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const json = body && req.headers["content-type"]?.includes("json") ? JSON.parse(body) : body;
  seen.push({ path: req.url, headers: req.headers, body: json });
  const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/token") return send({ access_token: "ya29.test", expires_in: 3600 });
  if (req.url.endsWith("/googleAds:search")) {
    if (json.query.includes("language_constant")) return send({ results: [{ languageConstant: { id: "1000", code: "en", name: "English" } }, { languageConstant: { id: "1056", code: "yo", name: "Yoruba" } }] });
    return send({ results: [{ customer: { id: "1234567890", descriptiveName: "Test", currencyCode: "NGN", timeZone: "Africa/Lagos" } }] });
  }
  if (req.url.endsWith("geoTargetConstants:suggest")) return send({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: "geoTargetConstants/2566", id: "2566", name: "Nigeria", canonicalName: "Nigeria", countryCode: "NG", targetType: "Country", status: "ENABLED" }, reach: "100000000", searchTerm: "Nigeria" }] });
  const metrics = (v) => ({ avgMonthlySearches: String(v), competition: "MEDIUM", competitionIndex: "45", lowTopOfPageBidMicros: "120000000", highTopOfPageBidMicros: "480000000",
    monthlySearchVolumes: Array.from({ length: 12 }, (_, i) => ({ year: i < 3 ? "2025" : "2026", month: ["OCTOBER","NOVEMBER","DECEMBER","JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER"][i], monthlySearches: String(v + i * 10) })) });
  if (req.url.endsWith(":generateKeywordIdeas")) {
    if (!json.pageToken) return send({ results: [{ text: "seo course", keywordIdeaMetrics: metrics(5400) }, { text: "seo training", keywordIdeaMetrics: metrics(880) }], nextPageToken: "p2", totalSize: "3" });
    return send({ results: [{ text: "learn seo", keywordIdeaMetrics: metrics(2900) }], totalSize: "3" });
  }
  if (req.url.endsWith(":generateKeywordHistoricalMetrics")) return send({ results: json.keywords.slice(0, 1).map((k) => ({ text: k, closeVariants: [k + "s"], keywordMetrics: metrics(1000) })) });
  if (req.url.endsWith(":generateKeywordForecastMetrics")) return send({ campaignForecastMetrics: { impressions: 12000.4, clicks: 340.2, costMicros: "150000000", clickThroughRate: 0.0283, averageCpcMicros: "441000" } });
  if (req.url.endsWith("customers:listAccessibleCustomers")) return send({ resourceNames: ["customers/1234567890", "customers/987"] });
  if (req.url.includes("fail")) return send({}, 500);
  send({ error: { message: "not mocked " + req.url } }, 404);
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const run = async (env, fn) => {
  const t = new StdioClientTransport({ command: "node", args: ["server/index.js"], env: { ...process.env, ...env } });
  const c = new Client({ name: "smoke", version: "1.0.0" });
  await c.connect(t); try { await fn(c); } finally { await c.close(); }
};

// 1. No credentials: tools listed, helpful error.
await run({ GOOGLE_ADS_DEVELOPER_TOKEN: "", GOOGLE_ADS_REFRESH_TOKEN: "" }, async (c) => {
  const tools = (await c.listTools()).tools.map((t) => t.name);
  check(tools.length === 7, `7 tools listed: ${tools.join(", ")}`);
  const r = await c.callTool({ name: "generate_keyword_ideas", arguments: { keywords: ["seo"] } });
  check(r.isError && r.content[0].text.includes("Missing configuration"), "missing config gives a clear error");
});

// 2. Mocked API: every tool.
const env = { GOOGLE_ADS_DEVELOPER_TOKEN: "dev", GOOGLE_ADS_CLIENT_ID: "cid", GOOGLE_ADS_CLIENT_SECRET: "sec", GOOGLE_ADS_REFRESH_TOKEN: "ref", GOOGLE_ADS_CUSTOMER_ID: "123-456-7890", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333", GOOGLE_ADS_API_BASE_URL: base, GOOGLE_OAUTH_TOKEN_URL: base + "/token" };
await run(env, async (c) => {
  const parse = (r) => JSON.parse(r.content[0].text.split("\n\n").slice(1).join("\n\n"));
  let r = await c.callTool({ name: "check_connection", arguments: {} });
  check(!r.isError && parse(r).currency === "NGN", "check_connection returns account details");
  r = await c.callTool({ name: "generate_keyword_ideas", arguments: { keywords: ["seo course"], locations: ["Nigeria"], language: "English", limit: 10 } });
  const ideas = parse(r).ideas;
  check(!r.isError && ideas.length === 3 && ideas[0].keyword === "seo course", "keyword ideas paginate and sort by searches");
  check(ideas[0].high_top_of_page_bid === 480 && ideas[0].three_month_change_pct !== null, "bids converted from micros and trend computed");
  const ideaReq = seen.find((s) => s.path.endsWith(":generateKeywordIdeas"));
  check(ideaReq.path === "/v25/customers/1234567890:generateKeywordIdeas", "correct endpoint, version and customer ID");
  check(ideaReq.body.geoTargetConstants[0] === "geoTargetConstants/2566" && ideaReq.body.language === "languageConstants/1000", "location and language names resolved to IDs");
  check(ideaReq.headers["developer-token"] === "dev" && ideaReq.headers["login-customer-id"] === "1112223333" && ideaReq.headers.authorization === "Bearer ya29.test", "auth headers sent");
  r = await c.callTool({ name: "generate_keyword_ideas", arguments: { site: "https://example.com/blog", limit: 5 } });
  check(seen.at(-1).body.siteSeed?.site === "example.com", "site seed normalised to a domain");
  r = await c.callTool({ name: "get_search_volume", arguments: { keywords: ["seo course", "zzz"], locations: ["2566"], start_month: "2025-10", end_month: "2026-09" } });
  const sv = parse(r);
  check(!r.isError && sv.results[0].monthly_searches.length === 12 && sv.no_data.includes("zzz"), "search volume returns monthly data and flags keywords with no data");
  check(seen.at(-1).body.historicalMetricsOptions.yearMonthRange.start.month === "OCTOBER", "month range converted to API format");
  r = await c.callTool({ name: "forecast_keywords", arguments: { keywords: [{ text: "seo course", match_type: "EXACT" }], max_cpc: 0.5, days: 30 } });
  const f = parse(r).forecast;
  check(!r.isError && f.cost === 150 && f.ctr_pct === 2.83, "forecast converts cost and CTR");
  check(seen.at(-1).body.campaign.adGroups[0].biddableKeywords[0].keyword.matchType === "EXACT" && seen.at(-1).body.currencyCode === "NGN", "forecast request well formed");
  r = await c.callTool({ name: "find_locations", arguments: { names: ["Nigeria"], country_code: "ng" } });
  check(!r.isError && parse(r)[0].id === "2566" && seen.at(-1).body.countryCode === "NG", "find_locations works");
  r = await c.callTool({ name: "list_languages", arguments: { filter: "yor" } });
  check(!r.isError && parse(r)[0].name === "Yoruba", "list_languages filters");
  r = await c.callTool({ name: "list_accessible_customers", arguments: {} });
  check(!r.isError && parse(r).customer_ids.length === 2, "list_accessible_customers works");
  r = await c.callTool({ name: "generate_keyword_ideas", arguments: { site: "a.com", keywords: ["x"] } });
  check(r.isError && r.content[0].text.includes("can't be combined"), "invalid seed combination rejected");
});

mock.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

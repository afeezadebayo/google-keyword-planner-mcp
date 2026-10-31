import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AdsClient, AdsError, NETWORKS, formatMetrics, loadConfig, missingConfig, money } from "./ads.js";

const VERSION = "1.1.0";
const cfg = loadConfig();
const ads = new AdsClient(cfg);

const server = new McpServer(
  { name: "google-keyword-planner", version: VERSION },
  {
    instructions:
      "Keyword research with Google Ads Keyword Planner data. Typical flow: generate_keyword_ideas from seed keywords or a URL, then get_search_volume for exact metrics on a shortlist, then forecast_keywords to estimate clicks and cost. Locations and languages accept plain names (\"Nigeria\", \"English\") or Google IDs. Search volumes are Google's rounded estimates.",
  },
);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const ok = (summary: string, data: unknown) => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof AdsError ? e.message : `Unexpected error: ${(e as Error)?.message ?? e}` }],
});

function guard() {
  const missing = missingConfig(cfg);
  if (missing.length)
    throw new AdsError(
      `Missing configuration: ${missing.join(", ")}.\nHow to fix: set these environment variables in your MCP client config. See the README for how to get each value.`,
    );
}

const locationsSchema = z
  .array(z.string())
  .max(10)
  .optional()
  .describe('Up to 10 locations as names ("Nigeria", "Lagos", "United Kingdom") or Google geo target IDs ("2566"). Omit for the default or worldwide.');
const languageSchema = z
  .string()
  .optional()
  .describe('Language name, code or ID, for example "English", "en" or "1000". Omit for the default (all languages if none set).');
const networkSchema = z.enum(NETWORKS).default("GOOGLE_SEARCH").describe("GOOGLE_SEARCH (default) or GOOGLE_SEARCH_AND_PARTNERS.");

/* ------------------------------ tools ------------------------------ */

server.registerTool(
  "generate_keyword_ideas",
  {
    title: "Generate keyword ideas",
    description:
      "Get keyword ideas from Keyword Planner using seed keywords, a page URL, a whole site, or keywords plus a URL. Returns each idea's average monthly searches, competition, top-of-page bid range, 3-month change, change across the period (first to last month), and monthly volumes.",
    inputSchema: {
      keywords: z.array(z.string()).max(20).optional().describe("Seed keywords (up to 20)."),
      url: z.string().url().optional().describe("A page URL to pull ideas from. Can be combined with keywords."),
      site: z.string().optional().describe('A whole domain to pull ideas from, e.g. "example.com". Can\'t be combined with keywords or url.'),
      locations: locationsSchema,
      language: languageSchema,
      network: networkSchema,
      include_adult_keywords: z.boolean().default(false),
      limit: z.number().int().min(1).max(2000).default(200).describe("Maximum ideas to return (default 200)."),
      min_searches: z.number().int().min(0).default(0).describe("Drop ideas below this average monthly search volume."),
      sort_by: z.enum(["searches", "competition_index", "high_bid", "relevance"]).default("searches"),
      include_monthly: z.boolean().default(false).describe("Include the 12-month volume series for each idea (larger output)."),
    },
    annotations: { title: "Generate keyword ideas", ...READ_ONLY },
  },
  async (a) => {
    try {
      guard();
      if (!a.keywords?.length && !a.url && !a.site) throw new AdsError("Provide at least one of keywords, url or site.");
      if (a.site && (a.keywords?.length || a.url)) throw new AdsError("site can't be combined with keywords or url. Use site on its own.");
      const [loc, language, currency] = await Promise.all([ads.resolveLocations(a.locations), ads.resolveLanguage(a.language), ads.accountCurrency()]);
      const body: any = {
        geoTargetConstants: loc.resourceNames,
        includeAdultKeywords: a.include_adult_keywords,
        keywordPlanNetwork: a.network,
        pageSize: 1000,
      };
      if (language) body.language = language;
      if (a.site) body.siteSeed = { site: a.site.replace(/^https?:\/\//, "").replace(/\/.*$/, "") };
      else if (a.keywords?.length && a.url) body.keywordAndUrlSeed = { url: a.url, keywords: a.keywords };
      else if (a.url) body.urlSeed = { url: a.url };
      else body.keywordSeed = { keywords: a.keywords };

      const raw: any[] = [];
      let pageToken: string | undefined;
      let total: number | undefined;
      do {
        const r = await ads.request("POST", ads.customerPath(":generateKeywordIdeas"), { ...body, pageToken });
        raw.push(...(r.results ?? []));
        total = r.totalSize ? Number(r.totalSize) : total;
        pageToken = r.nextPageToken;
      } while (pageToken && raw.length < a.limit * 2 && raw.length < 5000);

      let ideas: any[] = raw.map((r, i) => {
        const m = formatMetrics(r.keywordIdeaMetrics);
        if (!a.include_monthly) delete (m as any).monthly_searches;
        return { keyword: r.text, ...m, _rank: i };
      });
      ideas = ideas.filter((i) => (i.avg_monthly_searches ?? 0) >= a.min_searches);
      const key = { searches: "avg_monthly_searches", competition_index: "competition_index", high_bid: "high_top_of_page_bid" } as const;
      if (a.sort_by !== "relevance") {
        const k = key[a.sort_by];
        ideas.sort((x: any, y: any) => (y[k] ?? -1) - (x[k] ?? -1));
      }
      ideas = ideas.slice(0, a.limit).map(({ _rank, ...rest }: any) => rest);
      return ok(
        `${ideas.length} keyword ideas (of ${total ?? raw.length} found). Bids in ${currency}. Locations: ${loc.resolved.map((r) => r.name ?? r.id).join(", ") || "all"}. Language: ${language ?? "all"}.`,
        { currency, locations: loc.resolved, language: language ?? null, network: a.network, ideas },
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_search_volume",
  {
    title: "Get search volume and metrics",
    description:
      "Get historical Keyword Planner metrics for specific keywords: average monthly searches, monthly volumes, competition, top-of-page bid range and trends. Use this to check exact keywords rather than discover new ones. Close variants that Google groups together are listed.",
    inputSchema: {
      keywords: z.array(z.string()).min(1).max(10000).describe("Keywords to look up (up to 10,000)."),
      locations: locationsSchema,
      language: languageSchema,
      network: networkSchema,
      start_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("First month, YYYY-MM. Default: the last 12 months."),
      end_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Last month, YYYY-MM."),
      include_average_cpc: z.boolean().default(true),
    },
    annotations: { title: "Get search volume and metrics", ...READ_ONLY },
  },
  async (a) => {
    try {
      guard();
      const [loc, language, currency] = await Promise.all([ads.resolveLocations(a.locations), ads.resolveLanguage(a.language), ads.accountCurrency()]);
      const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
      const ym = (s: string) => ({ year: Number(s.slice(0, 4)), month: MONTHS[Number(s.slice(5, 7)) - 1] });
      const opts: any = { includeAverageCpc: a.include_average_cpc };
      if (a.start_month && a.end_month) opts.yearMonthRange = { start: ym(a.start_month), end: ym(a.end_month) };
      const unique = [...new Set(a.keywords.map((k) => k.trim()).filter(Boolean))];
      const results: any[] = [];
      for (let i = 0; i < unique.length; i += 1000) {
        const body: any = {
          keywords: unique.slice(i, i + 1000),
          geoTargetConstants: loc.resourceNames,
          keywordPlanNetwork: a.network,
          historicalMetricsOptions: opts,
        };
        if (language) body.language = language;
        const r = await ads.request("POST", ads.customerPath(":generateKeywordHistoricalMetrics"), body);
        for (const x of r.results ?? []) {
          results.push({ keyword: x.text, close_variants: x.closeVariants ?? [], ...formatMetrics(x.keywordMetrics) });
        }
      }
      const found = new Set(results.flatMap((r) => [r.keyword, ...r.close_variants].map((k: string) => k.toLowerCase())));
      const no_data = unique.filter((k) => !found.has(k.toLowerCase()));
      return ok(
        `Metrics for ${results.length} keywords${no_data.length ? ` (${no_data.length} returned no data)` : ""}. Bids in ${currency}.`,
        { currency, locations: loc.resolved, language: language ?? null, network: a.network, results, no_data },
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "forecast_keywords",
  {
    title: "Forecast clicks and cost",
    description:
      "Forecast impressions, clicks, cost, CTR and average CPC for a set of keywords over a future period, using Keyword Planner's forecasting. Useful for budgeting a paid search campaign.",
    inputSchema: {
      keywords: z
        .array(z.object({ text: z.string(), match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("BROAD") }))
        .min(1)
        .max(1000),
      max_cpc: z.number().positive().describe("Maximum cost per click bid, in the account currency (e.g. 0.8)."),
      days: z.number().int().min(1).max(365).default(30).describe("Forecast length in days, starting tomorrow."),
      locations: locationsSchema,
      language: languageSchema,
      network: networkSchema,
    },
    annotations: { title: "Forecast clicks and cost", ...READ_ONLY },
  },
  async (a) => {
    try {
      guard();
      const [loc, language, currency] = await Promise.all([ads.resolveLocations(a.locations), ads.resolveLanguage(a.language), ads.accountCurrency()]);
      const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const bid = Math.round(a.max_cpc * 1e6);
      const campaign: any = {
        keywordPlanNetwork: a.network,
        biddingStrategy: { manualCpcBiddingStrategy: { maxCpcBidMicros: String(bid) } },
        geoModifiers: loc.resourceNames.map((g) => ({ geoTargetConstant: g })),
        adGroups: [
          {
            maxCpcBidMicros: String(bid),
            biddableKeywords: a.keywords.map((k) => ({ maxCpcBidMicros: String(bid), keyword: { text: k.text, matchType: k.match_type } })),
          },
        ],
      };
      if (language) campaign.languageConstants = [language];
      const r = await ads.request("POST", ads.customerPath(":generateKeywordForecastMetrics"), {
        currencyCode: currency,
        forecastPeriod: { startDate: d(1), endDate: d(a.days) },
        campaign,
      });
      const m = r.campaignForecastMetrics ?? {};
      const num = (v: unknown) => (v === undefined ? null : Math.round(Number(v) * 100) / 100);
      const forecast = {
        impressions: num(m.impressions),
        clicks: num(m.clicks),
        cost: money(m.costMicros),
        ctr_pct: m.clickThroughRate === undefined ? null : Math.round(Number(m.clickThroughRate) * 10000) / 100,
        average_cpc: money(m.averageCpcMicros),
        conversions: num(m.conversions),
        conversion_rate_pct: m.conversionRate === undefined ? null : Math.round(Number(m.conversionRate) * 10000) / 100,
        average_cpa: money(m.averageCpaMicros),
      };
      return ok(`Forecast for ${a.days} days (${d(1)} to ${d(a.days)}) at a ${a.max_cpc} ${currency} max CPC.`, {
        currency,
        period: { start: d(1), end: d(a.days) },
        locations: loc.resolved,
        language: language ?? null,
        forecast,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "find_locations",
  {
    title: "Find location IDs",
    description: "Search Google's geo targets by name to get location IDs for countries, regions, cities and more.",
    inputSchema: {
      names: z.array(z.string()).min(1).max(25).describe('Place names, e.g. ["Lagos", "Abuja"].'),
      country_code: z.string().length(2).optional().describe('Limit to a country, e.g. "NG".'),
      locale: z.string().default("en"),
    },
    annotations: { title: "Find location IDs", ...READ_ONLY },
  },
  async (a) => {
    try {
      guard();
      const res = await ads.suggestLocations(a.names, a.country_code?.toUpperCase(), a.locale);
      return ok(`${res.length} matching locations.`, res);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_languages",
  {
    title: "List languages",
    description: "List the languages Keyword Planner can target, with their codes and IDs.",
    inputSchema: { filter: z.string().optional().describe("Optional text to filter by name or code.") },
    annotations: { title: "List languages", ...READ_ONLY },
  },
  async (a) => {
    try {
      guard();
      let langs = await ads.listLanguages();
      if (a.filter) {
        const f = a.filter.toLowerCase();
        langs = langs.filter((l) => l.name.toLowerCase().includes(f) || l.code.toLowerCase().includes(f));
      }
      return ok(`${langs.length} languages.`, langs);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_accessible_customers",
  {
    title: "List Google Ads accounts",
    description: "List the Google Ads customer IDs the signed-in user can access. Use it to find the right GOOGLE_ADS_CUSTOMER_ID.",
    inputSchema: {},
    annotations: { title: "List Google Ads accounts", ...READ_ONLY },
  },
  async () => {
    try {
      const missing = missingConfig(cfg).filter((m) => m !== "GOOGLE_ADS_CUSTOMER_ID");
      if (missing.length) throw new AdsError(`Missing configuration: ${missing.join(", ")}.`);
      const r = await ads.request("GET", "customers:listAccessibleCustomers");
      const ids = (r.resourceNames ?? []).map((n: string) => n.split("/")[1]);
      return ok(`${ids.length} accessible accounts.`, { customer_ids: ids, configured_customer_id: cfg.customerId || null });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "check_connection",
  {
    title: "Check connection",
    description: "Check that credentials work and show the configured account, API version, currency and defaults.",
    inputSchema: {},
    annotations: { title: "Check connection", ...READ_ONLY },
  },
  async () => {
    try {
      guard();
      const rows = await ads.search("SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1");
      const c = rows[0]?.customer ?? {};
      return ok("Connected to Google Ads.", {
        customer_id: c.id,
        account_name: c.descriptiveName,
        currency: c.currencyCode,
        time_zone: c.timeZone,
        api_version: cfg.apiVersion,
        login_customer_id: cfg.loginCustomerId ?? null,
        default_language: cfg.defaultLanguage ?? null,
        default_locations: cfg.defaultLocations ?? null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`google-keyword-planner-mcp ${VERSION} running on stdio (Google Ads API ${cfg.apiVersion})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Minimal Google Ads REST client for Keyword Planner endpoints.
 * Auth: OAuth2 refresh token. API access level comes from the OAuth client's Google Cloud project.
 */

export interface Config {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
  apiVersion: string;
  defaultLanguage?: string;
  defaultLocations?: string[];
}

const digits = (s?: string) => (s ? s.replace(/[^0-9]/g, "") : "");

export function loadConfig(env = process.env): Config {
  const cfg: Config = {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
    clientId: env.GOOGLE_ADS_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET ?? "",
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
    customerId: digits(env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || undefined,
    apiVersion: (env.GOOGLE_ADS_API_VERSION || "v25").replace(/^(\d)/, "v$1"),
    defaultLanguage: env.KEYWORD_PLANNER_DEFAULT_LANGUAGE || undefined,
    defaultLocations: env.KEYWORD_PLANNER_DEFAULT_LOCATIONS
      ? env.KEYWORD_PLANNER_DEFAULT_LOCATIONS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
  return cfg;
}

export function missingConfig(cfg: Config): string[] {
  const need: [keyof Config, string][] = [
    ["clientId", "GOOGLE_ADS_CLIENT_ID"],
    ["clientSecret", "GOOGLE_ADS_CLIENT_SECRET"],
    ["refreshToken", "GOOGLE_ADS_REFRESH_TOKEN"],
    ["customerId", "GOOGLE_ADS_CUSTOMER_ID"],
  ];
  return need.filter(([k]) => !cfg[k]).map(([, n]) => n);
}

export class AdsError extends Error {
  constructor(message: string, public status?: number, public details?: unknown) {
    super(message);
  }
}

/** Turn a Google Ads error payload into a readable explanation with a fix. */
function explainError(status: number, body: any): string {
  const err = body?.error ?? body;
  const parts: string[] = [];
  const codes: string[] = [];
  for (const d of err?.details ?? []) {
    for (const e of d?.errors ?? []) {
      const code = e?.errorCode ? Object.entries(e.errorCode).map(([k, v]) => `${k}.${v}`).join(", ") : "";
      if (code) codes.push(code);
      parts.push(`${code}${code ? ": " : ""}${e?.message ?? ""}`.trim());
    }
  }
  const all = (codes.join(" ") + " " + (err?.message ?? "")).toUpperCase();
  let hint = "";
  if (all.includes("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION") || all.includes("DEVELOPER_TOKEN_NOT_APPROVED") || all.includes("ONLY_APPROVED_FOR_TEST_ACCOUNTS") || all.includes("ACTION_NOT_PERMITTED"))
    hint = "Your Google Cloud project only has Test access to the Google Ads API. In Google Cloud Console, open the Google Ads API Overview page for the project that owns your OAuth client and apply for Basic access (it needs brand verification of your OAuth consent screen). Explorer access doesn't include Keyword Planner.";
  else if (all.includes("DEVELOPER_TOKEN_INVALID") || all.includes("DEVELOPER_TOKEN_PROHIBITED"))
    hint = "Google rejected the developer token. Developer tokens were retired on 9 September 2026; remove GOOGLE_ADS_DEVELOPER_TOKEN from your config, because access now comes from your Google Cloud project.";
  else if (all.includes("USER_PERMISSION_DENIED"))
    hint = "The signed-in Google user can't access this customer. If you access it through a manager account, set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account ID.";
  else if (all.includes("CUSTOMER_NOT_ENABLED") || all.includes("NOT_ACTIVE"))
    hint = "This Google Ads account isn't active. Keyword Planner needs an enabled account (it can have no running campaigns).";
  else if (all.includes("RESOURCE_EXHAUSTED") || all.includes("RESOURCE_TEMPORARILY_EXHAUSTED") || status === 429)
    hint = "Rate limit reached. Keyword Planner allows a limited number of requests per minute; wait a minute and try again.";
  else if (status === 401 || all.includes("UNAUTHENTICATED") || all.includes("INVALID_GRANT"))
    hint = "Authentication failed. The refresh token may have expired or been revoked; run `npm run auth` to create a new one.";
  else if (status === 404)
    hint = `API version not found. Set GOOGLE_ADS_API_VERSION to a current version (for example v25).`;
  const msg = parts.filter(Boolean).join("; ") || err?.message || `HTTP ${status}`;
  return hint ? `${msg}\nHow to fix: ${hint}` : msg;
}

export class AdsClient {
  private token?: { value: string; expires: number };
  private currency?: string;
  private languages?: { id: string; code: string; name: string }[];

  constructor(public cfg: Config) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    const res = await fetch(process.env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new AdsError(
        `Could not get an access token (${body.error ?? res.status}: ${body.error_description ?? ""}).\nHow to fix: check GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET, and run \`npm run auth\` to create a new refresh token.`,
        res.status,
      );
    }
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown, attempt = 0): Promise<any> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      "content-type": "application/json",
    };
    // Developer tokens were retired on 9 September 2026; access now comes from the OAuth client's Cloud project.
    if (this.cfg.developerToken) headers["developer-token"] = this.cfg.developerToken;
    if (this.cfg.loginCustomerId) headers["login-customer-id"] = this.cfg.loginCustomerId;
    const base = (process.env.GOOGLE_ADS_API_BASE_URL || "https://googleads.googleapis.com").replace(/\/$/, "");
    const url = `${base}/${this.cfg.apiVersion}/${path}`;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: { message: text.slice(0, 300) } };
    }
    if (!res.ok) {
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        return this.request(method, path, body, attempt + 1);
      }
      throw new AdsError(explainError(res.status, json), res.status, json);
    }
    return json;
  }

  customerPath(op: string) {
    return `customers/${this.cfg.customerId}${op}`;
  }

  async search(query: string): Promise<any[]> {
    const out: any[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.request("POST", this.customerPath("/googleAds:search"), { query, pageToken });
      out.push(...(r.results ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async accountCurrency(): Promise<string> {
    if (this.currency) return this.currency;
    try {
      const rows = await this.search("SELECT customer.currency_code FROM customer LIMIT 1");
      this.currency = rows[0]?.customer?.currencyCode ?? "USD";
    } catch {
      this.currency = "USD";
    }
    return this.currency!;
  }

  async listLanguages() {
    if (this.languages) return this.languages;
    const rows = await this.search(
      "SELECT language_constant.id, language_constant.code, language_constant.name, language_constant.targetable FROM language_constant WHERE language_constant.targetable = TRUE",
    );
    this.languages = rows
      .map((r) => ({ id: String(r.languageConstant?.id ?? ""), code: r.languageConstant?.code ?? "", name: r.languageConstant?.name ?? "" }))
      .filter((l) => l.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    return this.languages;
  }

  /** Accepts "1000", "languageConstants/1000", "en", "English". */
  async resolveLanguage(input?: string): Promise<string | undefined> {
    const v = (input ?? this.cfg.defaultLanguage ?? "").trim();
    if (!v) return undefined;
    if (/^languageConstants\/\d+$/.test(v)) return v;
    if (/^\d+$/.test(v)) return `languageConstants/${v}`;
    const langs = await this.listLanguages();
    const low = v.toLowerCase();
    const hit = langs.find((l) => l.code.toLowerCase() === low) ?? langs.find((l) => l.name.toLowerCase() === low);
    if (!hit) throw new AdsError(`Unknown language "${v}". Use list_languages to see valid names, codes and IDs.`);
    return `languageConstants/${hit.id}`;
  }

  async suggestLocations(names: string[], countryCode?: string, locale = "en") {
    const r = await this.request("POST", "geoTargetConstants:suggest", {
      locale,
      countryCode,
      locationNames: { names },
    });
    return (r.geoTargetConstantSuggestions ?? []).map((s: any) => ({
      id: String(s.geoTargetConstant?.id ?? ""),
      resourceName: s.geoTargetConstant?.resourceName,
      name: s.geoTargetConstant?.name,
      canonicalName: s.geoTargetConstant?.canonicalName,
      countryCode: s.geoTargetConstant?.countryCode,
      type: s.geoTargetConstant?.targetType,
      status: s.geoTargetConstant?.status,
      reach: s.reach ? Number(s.reach) : undefined,
      searchTerm: s.searchTerm,
    }));
  }

  /** Accepts IDs ("2566"), resource names, or place names ("Nigeria", "Lagos"). */
  async resolveLocations(inputs?: string[]): Promise<{ resourceNames: string[]; resolved: { input: string; id: string; name?: string }[] }> {
    const list = (inputs && inputs.length ? inputs : this.cfg.defaultLocations) ?? [];
    const resourceNames: string[] = [];
    const resolved: { input: string; id: string; name?: string }[] = [];
    for (const raw of list) {
      const v = raw.trim();
      if (!v) continue;
      if (/^geoTargetConstants\/\d+$/.test(v)) {
        resourceNames.push(v);
        resolved.push({ input: v, id: v.split("/")[1] });
      } else if (/^\d+$/.test(v)) {
        resourceNames.push(`geoTargetConstants/${v}`);
        resolved.push({ input: v, id: v });
      } else {
        const sugg = (await this.suggestLocations([v])).filter((s: any) => s.status !== "REMOVAL_PLANNED");
        const exact = sugg.find((s: any) => s.name?.toLowerCase() === v.toLowerCase()) ?? sugg[0];
        if (!exact) throw new AdsError(`Couldn't find a location called "${v}". Use find_locations to search for it.`);
        resourceNames.push(exact.resourceName);
        resolved.push({ input: v, id: exact.id, name: exact.canonicalName ?? exact.name });
      }
    }
    if (resourceNames.length > 10) throw new AdsError("Keyword Planner accepts at most 10 locations per request.");
    return { resourceNames, resolved };
  }
}

/* --------------------------- result formatting --------------------------- */

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export const money = (micros: unknown) =>
  micros === undefined || micros === null ? null : Math.round((Number(micros) / 1e6) * 100) / 100;

export function formatMetrics(m: any) {
  if (!m) return { avg_monthly_searches: null };
  const monthly = (m.monthlySearchVolumes ?? [])
    .map((x: any) => ({
      month: `${x.year}-${String(MONTHS.indexOf(String(x.month)) + 1).padStart(2, "0")}`,
      searches: x.monthlySearches === undefined ? null : Number(x.monthlySearches),
    }))
    .sort((a: any, b: any) => a.month.localeCompare(b.month));
  const vals = monthly.map((x: any) => x.searches ?? 0);
  const last = vals.at(-1);
  const threeAgo = vals.length >= 4 ? vals.at(-4) : undefined;
  const first = vals.length >= 2 ? vals[0] : undefined;
  const pct = (a?: number, b?: number) => (a === undefined || !b ? null : Math.round(((a - b) / b) * 100));
  return {
    avg_monthly_searches: m.avgMonthlySearches === undefined ? null : Number(m.avgMonthlySearches),
    competition: m.competition ?? null,
    competition_index: m.competitionIndex === undefined ? null : Number(m.competitionIndex),
    low_top_of_page_bid: money(m.lowTopOfPageBidMicros),
    high_top_of_page_bid: money(m.highTopOfPageBidMicros),
    average_cpc: money(m.averageCpcMicros),
    three_month_change_pct: pct(last, threeAgo),
    change_over_period_pct: pct(last, first),
    monthly_searches: monthly,
  };
}

export const NETWORKS = ["GOOGLE_SEARCH", "GOOGLE_SEARCH_AND_PARTNERS"] as const;

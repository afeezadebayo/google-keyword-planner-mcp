# Google Keyword Planner MCP server

<!-- mcp-name: io.github.afeezadebayo/google-keyword-planner -->

An MCP server that gives Claude and other MCP clients direct access to Google Ads Keyword Planner data: keyword ideas, average monthly searches, competition, top-of-page bid ranges, monthly trends and click and cost forecasts.

Built by [Afeez Adebayo](https://afeezadebayo.com). MIT licensed.

## What you can ask

- "Find 100 keyword ideas for *online accounting software* in Nigeria, sorted by search volume."
- "Get search volume for these 50 keywords in the UK and US, with their trends."
- "Pull keyword ideas from https://example.com/pricing."
- "Forecast clicks and cost for these exact-match keywords at a ₦300 max CPC for 30 days."

## Tools

| Tool | What it does |
| --- | --- |
| `generate_keyword_ideas` | Ideas from seed keywords, a URL, keywords plus a URL, or a whole site. Returns average monthly searches, competition, low and high top-of-page bids, 3-month change, change across the period (first to last month shown), and optional monthly volumes. Filter by minimum volume and sort by searches, competition, bid or relevance. |
| `get_search_volume` | Historical metrics for up to 10,000 exact keywords, with close variants and a list of keywords Google returned no data for. Optional month range. |
| `forecast_keywords` | Impressions, clicks, cost, CTR and average CPC for keywords at a given max CPC over 1 to 365 days. |
| `find_locations` | Look up Google location IDs by place name. |
| `list_languages` | List targetable languages with codes and IDs. |
| `list_accessible_customers` | List the Google Ads accounts your login can access. |
| `check_connection` | Confirm credentials and show the account, currency and defaults. |

Locations and languages accept plain names (`"Nigeria"`, `"Lagos"`, `"English"`) as well as Google IDs. Bids and costs are shown in your Google Ads account currency.

## What you need

Keyword Planner data comes from the Google Ads API. Since **9 September 2026**, Google no longer uses developer tokens: API access belongs to the Google Cloud project that owns your OAuth client. You need:

1. **A Google Ads account.** It must be enabled, but it doesn't need running campaigns. A manager account is optional.
2. **A Google Cloud project with the Google Ads API enabled.** In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the Google Ads API. This gives Test access, which only works with test accounts.
3. **Basic access for that project.** Keyword Planner isn't included in Explorer access, so you need Basic access:
   - Configure the OAuth consent screen (Google Auth Platform > Branding) and complete **brand verification**.
   - Open the [Google Ads API Overview page](https://console.cloud.google.com/google/ads-apis/overview) for the project and apply for Basic access. Google reviews it automatically, usually within minutes of brand verification.
   - If your project is on the Google Cloud free trial, Google may reject the application; upgrading the billing account to a paid tier fixes this (you won't be charged for the Google Ads API).
4. **An OAuth client ID** of type **Desktop app**, in the same project. Set the consent screen's publishing status to **In production**, because refresh tokens from apps in Testing status expire after 7 days.
5. **A refresh token.** Clone this repository and run:

   ```bash
   npm install
   GOOGLE_ADS_CLIENT_ID=your-client-id GOOGLE_ADS_CLIENT_SECRET=your-secret npm run auth
   ```

   Open the printed link, sign in with the Google account that can access your Ads account, and copy the refresh token it prints.

## Install

### Claude Desktop (one click)

Download `google-keyword-planner.mcpb` from the [latest release](https://github.com/afeezadebayo/google-keyword-planner-mcp/releases/latest) and open it. Claude Desktop asks for your credentials and stores the secrets securely.

### Any MCP client (from source)

```bash
git clone https://github.com/afeezadebayo/google-keyword-planner-mcp.git
cd google-keyword-planner-mcp
npm install && npm run build
```

Then add it to your client config:

```json
{
  "mcpServers": {
    "google-keyword-planner": {
      "command": "node",
      "args": ["/path/to/google-keyword-planner-mcp/server/index.js"],
      "env": {
        "GOOGLE_ADS_CLIENT_ID": "...",
        "GOOGLE_ADS_CLIENT_SECRET": "...",
        "GOOGLE_ADS_REFRESH_TOKEN": "...",
        "GOOGLE_ADS_CUSTOMER_ID": "123-456-7890",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "",
        "KEYWORD_PLANNER_DEFAULT_LANGUAGE": "English",
        "KEYWORD_PLANNER_DEFAULT_LOCATIONS": "Nigeria"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add google-keyword-planner \
  -e GOOGLE_ADS_CLIENT_ID=... -e GOOGLE_ADS_CLIENT_SECRET=... \
  -e GOOGLE_ADS_REFRESH_TOKEN=... -e GOOGLE_ADS_CUSTOMER_ID=123-456-7890 \
  -- node /path/to/google-keyword-planner-mcp/server/index.js
```

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Yes | OAuth client (Desktop app). Its Cloud project needs Basic access. |
| `GOOGLE_ADS_CLIENT_SECRET` | Yes | |
| `GOOGLE_ADS_REFRESH_TOKEN` | Yes | From `npm run auth`. |
| `GOOGLE_ADS_CUSTOMER_ID` | Yes | The account to query. Dashes are fine. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | No | Your manager account ID, if you access the account through one. |
| `GOOGLE_ADS_API_VERSION` | No | Defaults to `v25`. Change it when Google retires a version. |
| `KEYWORD_PLANNER_DEFAULT_LANGUAGE` | No | Used when a request doesn't name a language. |
| `KEYWORD_PLANNER_DEFAULT_LOCATIONS` | No | Comma-separated names or IDs used when a request doesn't name locations. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | No | Legacy. Google retired developer tokens on 9 September 2026; it's only sent if you set it. |

## Good to know

- **Volumes are estimates.** Keyword Planner rounds search volumes into ranges and groups close variants. Accounts with little or no ad spend may see broader ranges.
- **Rate limits.** Keyword Planner allows a limited number of requests per minute. The server retries rate-limit and server errors automatically with back-off.
- **Errors explain the fix.** Common problems (a Cloud project with only Test access, a missing manager account ID, an expired refresh token) come back with a plain-English explanation of how to fix them.
- **Privacy.** The server runs on your machine and talks only to Google. Credentials stay in your MCP client's config.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test   # runs every tool against a local mock of the Google Ads API
```

Releases are automated: bumping `version` in `package.json` and pushing to `main` builds the bundle, creates a GitHub release and publishes the listing to the official [MCP Registry](https://registry.modelcontextprotocol.io).

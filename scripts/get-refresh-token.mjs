// Creates a Google Ads OAuth refresh token using a local loopback redirect.
// Usage: GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... npm run auth
import http from "node:http";
import { randomBytes } from "node:crypto";

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET first (from a Google Cloud OAuth client of type 'Desktop app').");
  process.exit(1);
}
const state = randomBytes(16).toString("hex");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") return res.end();
  if (url.searchParams.get("state") !== state) { res.end("State mismatch. Try again."); return; }
  const code = url.searchParams.get("code");
  if (!code) { res.end(`Authorisation failed: ${url.searchParams.get("error")}`); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const body = await r.json();
  if (!body.refresh_token) {
    res.end("No refresh token returned. Remove the app's access at myaccount.google.com/permissions and run this again.");
    console.error(body);
  } else {
    res.end("Done. You can close this tab and return to the terminal.");
    console.log(`\nGOOGLE_ADS_REFRESH_TOKEN=${body.refresh_token}\n\nKeep this secret. Add it to your MCP client config.`);
  }
  server.close();
});
let redirect = "";
server.listen(0, "127.0.0.1", () => {
  redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "https://www.googleapis.com/auth/adwords", access_type: "offline", prompt: "consent", state }).toString();
  console.log(`Open this URL in your browser and sign in with the Google account that can access your Google Ads account:\n\n${auth}\n`);
});

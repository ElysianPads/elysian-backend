const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
let runtimePlaidAccessToken = null;

function plaidBaseUrl() {
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  const urls = {
    sandbox: "https://sandbox.plaid.com",
    development: "https://development.plaid.com",
    production: "https://production.plaid.com"
  };

  if (!urls[env]) {
    throw new Error(`Unsupported PLAID_ENV: ${env}`);
  }

  return urls[env];
}

async function plaidRequest(path, body = {}) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    const error = new Error("PLAID_CLIENT_ID and PLAID_SECRET must be configured in Railway.");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error_message || data.display_message || "Plaid request failed");
    error.statusCode = response.status;
    error.plaid = data;
    throw error;
  }

  return data;
}

function getPlaidAccessToken() {
  return process.env.PLAID_ACCESS_TOKEN || runtimePlaidAccessToken;
}

function requirePlaidAccessToken() {
  const token = getPlaidAccessToken();
  if (!token) {
    const error = new Error("No Plaid access token is configured. Connect Relay first, then add PLAID_ACCESS_TOKEN to Railway for persistence.");
    error.statusCode = 400;
    throw error;
  }
  return token;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Public health check for Railway.
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "elysian-backend" });
});

// Public UI only. The page does not contain any bank or Plaid secrets.
// The user must enter INTERNAL_API_KEY before it can call protected endpoints.
app.get("/plaid/connect", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect Relay to Elysian Pads</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; line-height: 1.5; }
    input, button { font: inherit; padding: 10px 12px; }
    input { width: 100%; box-sizing: border-box; margin: 8px 0 12px; }
    button { cursor: pointer; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f5f5f5; padding: 12px; border-radius: 8px; }
    .warning { margin-top: 18px; }
  </style>
</head>
<body>
  <h1>Connect Relay through Plaid</h1>
  <p>This connection is read-only. It enables account, balance, and transaction retrieval only.</p>
  <label for="key">Internal API key</label>
  <input id="key" type="password" autocomplete="off" placeholder="INTERNAL_API_KEY" />
  <button id="connect">Connect Relay</button>
  <p id="status"></p>
  <pre id="result" hidden></pre>
  <p class="warning"><strong>Important:</strong> after a successful connection, add the displayed access token to Railway as <code>PLAID_ACCESS_TOKEN</code>. Until then it only lives in the currently running Railway process and will be lost on restart/redeploy.</p>

<script>
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');

async function api(path, body) {
  const key = document.getElementById('key').value.trim();
  if (!key) throw new Error('Enter your INTERNAL_API_KEY first.');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

document.getElementById('connect').addEventListener('click', async () => {
  try {
    resultEl.hidden = true;
    statusEl.textContent = 'Creating secure Plaid session...';
    const tokenData = await api('/plaid/link-token');
    const handler = Plaid.create({
      token: tokenData.link_token,
      onSuccess: async (publicToken, metadata) => {
        try {
          statusEl.textContent = 'Connected. Saving Plaid connection...';
          const exchange = await api('/plaid/exchange-token', { public_token: publicToken });
          resultEl.hidden = false;
          resultEl.textContent = 'PLAID_ACCESS_TOKEN=' + exchange.access_token + '\n\nItem ID: ' + exchange.item_id + '\nInstitution: ' + (metadata.institution?.name || 'Connected institution');
          statusEl.textContent = 'Relay connection completed.';
        } catch (error) {
          statusEl.textContent = error.message;
        }
      },
      onExit: (error) => {
        statusEl.textContent = error ? (error.display_message || error.error_message || 'Plaid Link closed with an error.') : 'Plaid Link closed.';
      }
    });
    handler.open();
  } catch (error) {
    statusEl.textContent = error.message;
  }
});
</script>
</body>
</html>`);
});

// Protect all routes below this point with the existing internal bearer key.
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!process.env.INTERNAL_API_KEY || auth !== `Bearer ${process.env.INTERNAL_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Existing Lodgify route retained.
app.get("/properties", asyncRoute(async (req, res) => {
  const response = await fetch("https://api.lodgify.com/v2/properties", {
    headers: { Authorization: `Bearer ${process.env.LODGIFY_API_KEY}` }
  });
  const data = await response.json();
  res.status(response.status).json(data);
}));

// Create a Plaid Link token for a read-only Transactions connection.
app.post("/plaid/link-token", asyncRoute(async (req, res) => {
  const request = {
    user: { client_user_id: "elysian-pads-relay" },
    client_name: "Elysian Pads",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    country_codes: ["US"],
    language: "en"
  };

  if (process.env.PLAID_REDIRECT_URI) {
    request.redirect_uri = process.env.PLAID_REDIRECT_URI;
  }

  const data = await plaidRequest("/link/token/create", request);
  res.json({ link_token: data.link_token, expiration: data.expiration });
}));

// Exchange the temporary public token after the user finishes Plaid Link.
app.post("/plaid/exchange-token", asyncRoute(async (req, res) => {
  if (!req.body.public_token) {
    return res.status(400).json({ error: "public_token is required" });
  }

  const data = await plaidRequest("/item/public_token/exchange", {
    public_token: req.body.public_token
  });

  runtimePlaidAccessToken = data.access_token;

  res.json({
    access_token: data.access_token,
    item_id: data.item_id,
    persistence_required: !process.env.PLAID_ACCESS_TOKEN,
    next_step: "Add access_token to Railway as PLAID_ACCESS_TOKEN so it survives redeploys."
  });
}));

// Read Relay accounts and current balances.
app.get("/plaid/accounts", asyncRoute(async (req, res) => {
  const data = await plaidRequest("/accounts/balance/get", {
    access_token: requirePlaidAccessToken()
  });
  res.json({ accounts: data.accounts, item: data.item });
}));

// Read transactions over a date range. Defaults to the most recent 30 days.
app.get("/plaid/transactions", asyncRoute(async (req, res) => {
  const end = req.query.end_date ? new Date(`${req.query.end_date}T00:00:00Z`) : new Date();
  const start = req.query.start_date ? new Date(`${req.query.start_date}T00:00:00Z`) : new Date(end.getTime() - 29 * 86400000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ error: "Dates must use YYYY-MM-DD format." });
  }

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const accessToken = requirePlaidAccessToken();
  const transactions = [];
  let accounts = [];
  let totalTransactions = 0;
  let offset = 0;

  do {
    const options = { count: 500, offset };
    if (req.query.account_id) options.account_ids = [req.query.account_id];

    const data = await plaidRequest("/transactions/get", {
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options
    });

    transactions.push(...data.transactions);
    accounts = data.accounts;
    totalTransactions = data.total_transactions;
    offset = transactions.length;
  } while (transactions.length < totalTransactions);

  res.json({
    start_date: startDate,
    end_date: endDate,
    total_transactions: totalTransactions,
    accounts,
    transactions
  });
}));

// Safe status route: confirms configuration without exposing secrets.
app.get("/plaid/status", (req, res) => {
  res.json({
    plaid_env: process.env.PLAID_ENV || "sandbox",
    plaid_credentials_configured: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    plaid_access_token_configured: Boolean(getPlaidAccessToken())
  });
});

app.use((error, req, res, next) => {
  console.error(error.plaid || error);
  res.status(error.statusCode || 500).json({
    error: error.message || "Internal server error",
    plaid_error_code: error.plaid?.error_code || undefined,
    plaid_error_type: error.plaid?.error_type || undefined,
    request_id: error.plaid?.request_id || undefined
  });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

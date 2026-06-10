# Cookiehub integration (Forge app) — technical documentation

This document describes how the **Cookiehub** integration works inside this Forge app (`golive-app`), including the UI flow, backend resolvers, issue-property storage, and Cookiehub Client API interactions.

## Overview

The Cookiehub integration is implemented **inside the Forge app** (not via the external “go-live API” service used by other integrations such as mysites.guru).

At a high level:

- The user provides a **Website URL** in the panel (or the app falls back to a Jira Issue “Website URL” field if configured).
- The app checks Cookiehub to see whether a **domain project** already exists for that hostname.
- If a domain exists, the UI is updated to show it.
- If a domain does not exist, the user can click **Run** to create it.

Cookiehub dashboard: [https://dash.cookiehub.com/](https://dash.cookiehub.com/)

API reference (Postman collection): [Cookiehub Client API](https://www.postman.com/dark-spaceship-4473/cookiehub-api/collection/7owf8ij/client-api)

## Key files

- **Backend (Forge function)**:
  - `src/index.js` — Forge resolver definitions and Jira issue property read/write.
  - `src/cookiehub.js` — Cookiehub Client API client, HMAC authentication, and integration logic.
- **Frontend (Custom UI)**:
  - `static/hello-world/src/App.js` — Issue panel UI, including the Website URL input, Refresh behavior, and Run actions.

## Data model and storage

Integration state is stored **per Jira issue** using an Issue Property.

- **Issue property key**: `forge.goLiveIntegrations` (constant `ISSUE_PROPERTY_KEY` in `src/index.js`)
- **Stored shape (conceptual)**:

```json
{
  "siteUrlOverride": "https://example.com",
  "siteUrl": "https://example.com",
  "integrations": {
    "cookiehub": {
      "status": "success|failed|running|not_started",
      "label": "Cookiehub",
      "id": "985091",
      "url": "https://dash.cookiehub.com/domain/985091",
      "message": "Human readable status",
      "lastError": "Error message (only when failed)",
      "details": { "domain": { "...": "..." } },
      "updatedAt": "2026-06-10T10:00:00.000Z"
    }
  }
}
```

Notes:

- `siteUrlOverride` is written by the panel’s **Save** button.
- `siteUrl` is also stored for convenience/traceability and to keep existing behavior consistent.
- `integrations.cookiehub` is written by:
  - `runIntegration` (when the user clicks **Run** for Cookiehub)
  - `syncCookiehub` (when the user clicks **Refresh** or when the panel loads)

## URL sources and normalization

There are two possible inputs for the URL used by Cookiehub:

1. **Panel override** (preferred when set): `siteUrlOverride` stored in the issue property.
2. **Jira issue custom field**: configured by `WEBSITE_URL_FIELD_ID` (Forge environment variable).

The effective site URL is normalized in `src/index.js` (scheme, trailing slash, etc.).

Cookiehub uses the **hostname only** as the domain name:

- `domainNameFromUrl(siteUrl)` → `new URL(siteUrl).hostname` (lowercased)
- Example: `https://www.example.com/shop` → `www.example.com`

Comparison when searching existing domains is **case-insensitive**.

## UI behaviors (Custom UI)

### Website URL input

The panel includes a **Website URL** input box and **Save** button.

- **Save** calls backend resolver: `setSiteUrlOverride({ siteUrl })`
- Backend validates/normalizes the URL and stores it as `siteUrlOverride` on the issue property.
- **Cookiehub**, **Matomo**, and **Betterstack** all use this effective URL.

### Refresh button behavior (Cookiehub specific)

Pressing **Refresh** (and the initial panel load) performs:

1. Calls `syncCookiehub` (backend) to reconcile Cookiehub state for the current URL.
2. Calls `syncMatomo` and `syncBetterstack` for the other integrations.
3. Calls `getPanelData` to render the latest state.

This guarantees:

- If no Cookiehub domain exists for the current hostname, the **Cookiehub row resets** and the **Run** button becomes available again.
- If a domain exists, Cookiehub is shown as **success** with the domain ID and dashboard link.

### Run button behavior

Clicking **Run** on Cookiehub calls `runIntegration({ integration: 'cookiehub' })`.

- The UI sets a `busyKey` so the user can’t run multiple integrations simultaneously.
- Backend writes a “running” state immediately (so the UI shows progress), then executes the integration.

## Backend resolvers (Forge)

All resolvers are defined in `src/index.js`.

### `getPanelData`

Returns the data required by the UI, including `integrations.cookiehub` and `COOKIEHUB_SITE_ID_FIELD_ID` config when set.

### `setSiteUrlOverride`

Payload:

- `siteUrl` (string)

Behavior:

- Normalizes the URL
- Writes `siteUrlOverride` into the issue property
- Returns `{ ok: true, siteUrl: normalized }`

### `syncCookiehub`

No payload; uses the current issue context.

Behavior:

- Resolves the effective `siteUrl` for the issue.
- If `siteUrl` is missing:
  - Clears `integrations.cookiehub` state (resets Cookiehub in the UI).
- Else, queries Cookiehub:
  - If **no domain** exists for the hostname:
    - Clears `integrations.cookiehub` state (resets Cookiehub in the UI).
  - If a **domain exists**:
    - Calls `GET /domain/{id}` to verify and writes Cookiehub status to `success`.
  - If the Cookiehub API call fails:
    - Writes `failed` state with status code + details.

### `runIntegration`

Payload:

- `integration` (string key)

Behavior:

- For Cookiehub:
  - Uses `runCookiehubIntegration({ siteUrl, siteName })` from `src/cookiehub.js`
  - Writes the final status into the issue property
  - Optionally writes the returned domain ID into a Jira custom field if `COOKIEHUB_SITE_ID_FIELD_ID` is configured.
- For Matomo and Betterstack:
  - Uses in-app logic (see `docs/matomo.md` and `docs/betterstack.md`).
- For other integrations:
  - Calls the external go-live API service (unchanged behavior).

## Cookiehub Client API interactions

All Cookiehub API calls are implemented in `src/cookiehub.js`.

### Base URL

- `https://dash.cookiehub.com/client-api/v2`

### Authentication (both keys required)

Cookiehub uses **dynamic bearer tokens** built from a **public key** and a **private key**. Both keys are generated in the Cookiehub dashboard under **Account → API keys**.

Per the [Client API documentation](https://www.postman.com/dark-spaceship-4473/cookiehub-api/collection/7owf8ij/client-api):

1. **Create a signature** by hashing the following string with **HMAC-SHA256**, using the **private key** as the secret:

```
[currentDate].[METHOD].[fullUrl]
```

Example:

```
2021-11-04.GET.https://dash.cookiehub.com/client-api/v2/domain
```

2. **Create the bearer token** by combining the public key and signature:

```
[publicKey].[signature]
```

3. Send the request with:

```
Authorization: Bearer [publicKey].[signature]
```

Implementation notes:

- `[currentDate]` is `YYYY-MM-DD` (UTC date slice from ISO string).
- `[METHOD]` is the HTTP method in uppercase (`GET`, `POST`, etc.).
- `[fullUrl]` is the **exact** request URL including path (e.g. `https://dash.cookiehub.com/client-api/v2/domain`).
- The signature must be recalculated for **every request** (it changes daily and per URL/method).
- Current implementation uses hardcoded constants: `COOKIEHUB_PUBLIC_KEY` and `COOKIEHUB_PRIVATE_KEY`.

### API methods used

1. **List domains**
   - `GET /client-api/v2/domain`
   - Returns paginated list of domain projects.
   - Response shape (simplified):

```json
{
  "total": 92,
  "pagination": { "pageSize": 20, "pages": 5, "current": 1 },
  "items": [
    {
      "id": 985091,
      "code": "5b748ec8",
      "name": "example.com",
      "published": false,
      "subscription": { "name": "Enterprise" }
    }
  ]
}
```

2. **Get domain details**
   - `GET /client-api/v2/domain/{id}`
   - Used to verify an existing or newly created domain.
   - Returns full domain configuration and metadata.

3. **Create domain**
   - `POST /client-api/v2/domain`
   - Request body:

```json
{
  "name": "example.com"
}
```

   - Success response:

```json
{
  "success": true,
  "id": 1016859,
  "code": "436e3ef3",
  "error": "",
  "errors": []
}
```

   - Duplicate domain response:

```json
{
  "success": false,
  "id": 0,
  "code": "",
  "error": "Domain example.com already exists.",
  "errors": []
}
```

### Domain naming rule

The domain `name` sent to Cookiehub is the **hostname only** (lowercased):

- `name = new URL(siteUrl).hostname`
- Example: `https://www.example.com/shop` → `www.example.com`

Cookiehub validates domain names; invalid hostnames return errors such as `"Domain … is not valid."`.

### Dashboard URL

When a domain is found or created, the integration stores a link to the Cookiehub dashboard:

```
https://dash.cookiehub.com/domain/{id}
```

If a domain is known to exist but the ID cannot be resolved (see pagination note below), the app may fall back to:

```
https://dash.cookiehub.com/
```

## Integration algorithm (Cookiehub)

### `runCookiehubIntegration({ siteUrl })`

1. Derive `domainName` from the site URL hostname.
2. Call **`findDomainByName(domainName)`** (lists domains and searches by `name`).
3. If a domain is found:
   - Call **`GET /domain/{id}`** to verify.
   - Return `ok: true` with domain ID and dashboard URL.
4. If no domain is found:
   - Call **`POST /domain`** with `{ name: domainName }`.
5. If create succeeds (`success: true`):
   - Parse `id` from response.
   - Call **`GET /domain/{id}`** (best effort) to verify.
   - Return `ok: true` with new domain ID.
6. If create fails with **“already exists”**:
   - Retry **`findDomainByName`** (domain may have been created outside the first list page).
   - If found: return `ok: true` with ID.
   - If still not found: return `ok: true` with `id: null` and generic dashboard URL (domain exists in Cookiehub but ID not resolved).

### `syncCookiehub`

- Uses **`findDomainByName`** only (read-only; does not create domains).
- If no domain exists, **resets Cookiehub state** so “Run” becomes available again.
- If a domain exists, calls **`GET /domain/{id}`** and marks Cookiehub as **success**.

## List pagination (operational note)

The list endpoint returns paginated results (default **20 items per page**). The app attempts to fetch additional pages using:

```
GET /client-api/v2/domain?current={page}
```

In practice, requests with query parameters may return **403 Forbidden** depending on API configuration. When pagination fails, the app uses only the **first page** of results.

Implications:

- Domains on later pages may not be found during **Refresh** (`syncCookiehub`), causing the UI to show **Run** even though the domain exists.
- Clicking **Run** in that case will call **create**, receive **“already exists”**, and mark the integration as **success** (with or without a resolved ID).
- For accounts with many domains, consider improving pagination support or adding a dedicated lookup endpoint if Cookiehub exposes one.

## Egress (outbound access)

Forge requires explicit egress allowlisting.

- `manifest.yml` includes `https://dash.cookiehub.com` under `permissions.external.fetch.backend`

After adding or changing egress permissions, redeploy and **upgrade** the Forge app install.

## Operational notes / expected behavior

- **Refresh is “state reconciliation”**, not just re-rendering:
  - It can modify the saved issue property (reset Cookiehub or set it to success).
- **Run is “create or validate”**:
  - It will not create duplicates when a domain is found in the list first.
  - Duplicate creation attempts are handled via the “already exists” error path.
- **Optional Jira field write-back**:
  - If `COOKIEHUB_SITE_ID_FIELD_ID` is set as a Forge environment variable, a successful Run writes the Cookiehub domain ID into that Jira custom field.
- **Rate limiting**:
  - Cookiehub responses include `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers (observed limit: 60 requests).

## Error handling

The Cookiehub client treats a response as failed when:

- HTTP status is not OK, or
- Create response has `success: false` and the error is not “already exists”

Error messages from Cookiehub are surfaced in the UI via the `message` / `lastError` fields on the integration row.

Common errors:

| Symptom | Likely cause |
|--------|----------------|
| `401` / `403` on API calls | Invalid keys, incorrect signature (wrong date/URL/method), or expired/revoked API key |
| `Domain … is not valid` | Hostname failed Cookiehub validation |
| `Domain … already exists` | Domain already registered (handled as success on Run) |
| `Failed to check Cookiehub domains` on load | API call failed during `syncCookiehub` (auth, egress, or network) |

## Suggested future hardening (optional)

1. **Move keys out of code**
   - Store `COOKIEHUB_PUBLIC_KEY` and `COOKIEHUB_PRIVATE_KEY` in Forge environment variables.
2. **Reliable pagination**
   - Confirm with Cookiehub the supported pagination mechanism for `GET /domain` when accounts have more than one page of domains.
3. **Configurable defaults on create**
   - Pass additional fields to `POST /domain` if IIT requires specific subscription, regional settings, or policy templates for new domains.
4. **Avoid false negatives on sync**
   - When sync cannot paginate, optionally treat “already exists” from a lightweight probe without creating (if Cookiehub adds a check endpoint).
5. **Timezone for signature date**
   - Document or configure whether Cookiehub expects UTC date vs account timezone for the `[currentDate]` component.

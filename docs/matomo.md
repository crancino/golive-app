# Matomo integration (Forge app) — technical documentation

This document describes how the **Matomo** integration works inside this Forge app (`golive-app`), including the UI flow, backend resolvers, issue-property storage, and Matomo Reporting API interactions.

## Overview

The Matomo integration is implemented **inside the Forge app** (not via the external “go-live API” service used by other integrations such as Cookiehub or mysites.guru).

At a high level:

- The user provides a **Website URL** in the panel (or the app falls back to a Jira Issue “Website URL” field if configured).
- The app checks Matomo to see whether a site already exists for that URL.
- If a site exists, the UI is updated to show it.
- If a site does not exist, the user can click **Run** to create it.

Matomo instance used: [https://iit.matomo.cloud/](https://iit.matomo.cloud/)

## Key files

- **Backend (Forge function)**:
  - `src/index.js` — Forge resolver definitions and Jira issue property read/write.
  - `src/matomo.js` — Matomo Reporting API client and integration logic.
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
    "matomo": {
      "status": "success|failed|running|not_started",
      "label": "Matomo",
      "id": "42",
      "url": "https://iit.matomo.cloud/index.php?module=CoreHome&action=index&idSite=42",
      "message": "Human readable status",
      "lastError": "Error message (only when failed)",
      "details": { "site": { "...": "..." } },
      "updatedAt": "2026-05-28T10:00:00.000Z"
    }
  }
}
```

Notes:

- `siteUrlOverride` is written by the panel’s **Save** button.
- `siteUrl` is also stored for convenience/traceability and to keep existing behavior consistent.
- `integrations.matomo` is written by:
  - `runIntegration` (when the user clicks **Run** for Matomo)
  - `syncMatomo` (when the user clicks **Refresh** or when the panel loads)

## URL sources and normalization

There are two possible inputs for the URL used by Matomo:

1. **Panel override** (preferred when set): `siteUrlOverride` stored in the issue property.
2. **Jira issue custom field**: configured by `WEBSITE_URL_FIELD_ID` (Forge environment variable).

Normalization logic (in `src/index.js`):

- Accepts either a domain (`example.com`) or a full URL (`https://example.com`).
- If no scheme is provided, it assumes `https://`.
- Trims whitespace and removes a trailing `/`.
- Invalid inputs normalize to `null`.

The backend uses the “effective” site context computed by `getEffectiveSiteContext(issueKey)`:

- Reads the issue and the issue property
- Applies override first, then issue field
- Returns `{ siteName, siteUrl, state, issue }`

## UI behaviors (Custom UI)

### Website URL input

The panel includes a **Website URL** input box and **Save** button.

- **Save** calls backend resolver: `setSiteUrlOverride({ siteUrl })`
- Backend validates/normalizes the URL and stores it as `siteUrlOverride` on the issue property.
- Both **Matomo** and **Betterstack** use this effective URL.

### Refresh button behavior (Matomo specific)

Pressing **Refresh** (and the initial panel load) performs:

1. Calls `syncMatomo` (backend) to reconcile Matomo state for the current URL.
2. Calls `syncBetterstack` (backend) for Betterstack reconciliation.
3. Calls `getPanelData` to render the latest state.

This guarantees:

- If no Matomo site exists for the current URL, the **Matomo row resets** and the **Run** button becomes available again.
- If a site exists, Matomo is shown as **success** with the site ID and dashboard link.

### Run button behavior

Clicking **Run** on Matomo calls `runIntegration({ integration: 'matomo' })`.

- The UI sets a `busyKey` so the user can’t run multiple integrations simultaneously.
- Backend writes a “running” state immediately (so the UI shows progress), then executes the integration.

## Backend resolvers (Forge)

All resolvers are defined in `src/index.js`.

### `getPanelData`

Returns the data required by the UI:

- `issueKey`, `projectKey`
- `siteName`
- `siteUrl` (effective URL after override/field logic)
- `siteUrlOverride`
- `integrations` (status/IDs/links/messages)
- selected configuration env vars (field ids), including `MATOMO_SITE_ID_FIELD_ID`

### `setSiteUrlOverride`

Payload:

- `siteUrl` (string)

Behavior:

- Normalizes the URL
- Writes `siteUrlOverride` into the issue property
- Returns `{ ok: true, siteUrl: normalized }`

### `syncMatomo`

No payload; uses the current issue context.

Behavior:

- Resolves the effective `siteUrl` for the issue.
- If `siteUrl` is missing:
  - Clears `integrations.matomo` state (resets Matomo in the UI).
- Else, queries Matomo:
  - If **no site** exists for the URL:
    - Clears `integrations.matomo` state (resets Matomo in the UI).
  - If a **site exists**:
    - Calls `SitesManager.getSiteFromId` to verify and writes Matomo status to `success`.
  - If the Matomo API call fails:
    - Writes `failed` state with status code + details.

### `runIntegration`

Payload:

- `integration` (string key)

Behavior:

- For Matomo:
  - Uses `runMatomoIntegration({ siteUrl, siteName })` from `src/matomo.js`
  - Writes the final status into the issue property
  - Optionally writes the returned site ID into a Jira custom field if `MATOMO_SITE_ID_FIELD_ID` is configured.
- For Betterstack:
  - Uses in-app Better Stack logic (see `docs/betterstack.md`).
- For other integrations:
  - Calls the external go-live API service (unchanged behavior).

## Matomo Reporting API interactions

All Matomo API calls are implemented in `src/matomo.js`.

API reference: [Matomo Reporting API](https://developer.matomo.org/api-reference/reporting-api)

Querying guide: [Querying the Reporting API](https://developer.matomo.org/guides/querying-the-reporting-api)

### Authentication

- Uses `token_auth` (Matomo API token).
- Current implementation uses a hardcoded token constant: `MATOMO_TOKEN`.
- **Important (Matomo Cloud)**: `token_auth` must be sent as a **POST** parameter. Sending it in the query string on a GET request returns **401 Unauthorized** with the message:
  > *"Unable to authenticate with the provided token. It is either invalid, expired or is required to be sent as a POST parameter."*

`SitesManager.addSite` requires **superuser** access. The provided token must belong to a superuser account on `iit.matomo.cloud`.

### Base URL

- `https://iit.matomo.cloud`
- All API requests go to: `POST https://iit.matomo.cloud/index.php`

### Request format

Every call uses `application/x-www-form-urlencoded` POST body:

| Parameter    | Value                                      |
|-------------|---------------------------------------------|
| `module`    | `API`                                       |
| `method`    | e.g. `SitesManager.getSitesIdFromSiteUrl`   |
| `format`    | `JSON`                                      |
| `token_auth`| API token                                   |
| …           | method-specific parameters                  |

Array parameters (e.g. `urls` for `addSite`) are sent as repeated `urls[]` fields.

### API methods used

1. **Find site by URL**
   - Method: `SitesManager.getSitesIdFromSiteUrl`
   - Parameter: `url=<siteUrl>`
   - Returns: JSON array of site IDs, e.g. `[]` or `[42]`
   - Used to detect whether a site already exists for the URL.

2. **Get site details (verification)**
   - Method: `SitesManager.getSiteFromId`
   - Parameter: `idSite=<siteId>`
   - Returns: site object (includes `idsite`, `name`, `main_url`, etc.)
   - Used after finding an existing site, and after creating a new one, to verify the site is accessible.

3. **Create site**
   - Method: `SitesManager.addSite`
   - Parameters:
     - `siteName` — hostname only (see naming rule below)
     - `urls[]` — the site URL (at least one required)
   - Returns: the new site ID (integer in JSON)
   - Requires superuser `token_auth`.

Example create payload (conceptual):

```
module=API
method=SitesManager.addSite
format=JSON
token_auth=<token>
siteName=example.com
urls[]=https://example.com
```

### Site naming rule

Site name is derived from the URL hostname only:

- `siteName = new URL(siteUrl).hostname`
- Example: `https://www.example.com/shop` → `www.example.com`

The Jira issue summary (`siteName` from the issue) is **not** used for the Matomo site name.

### Dashboard URL

When a site is found or created, the integration stores a link to the Matomo dashboard:

```
https://iit.matomo.cloud/index.php?module=CoreHome&action=index&idSite={siteId}
```

## Integration algorithm (Matomo)

### `runMatomoIntegration({ siteUrl, siteName })`

1. Call **`SitesManager.getSitesIdFromSiteUrl`** with the normalized URL.
2. If one or more site IDs are returned:
   - Use the **first** site ID.
   - Call **`SitesManager.getSiteFromId`** to verify.
   - If verification succeeds: return `ok: true` with existing site ID and dashboard URL.
   - If verification fails: return `ok: false`.
3. If no site exists:
   - Call **`SitesManager.addSite`** with `siteName` (hostname) and `urls[]` (site URL).
   - Parse the returned site ID.
   - Call **`SitesManager.getSiteFromId`** (best effort) to verify creation.
   - Return `ok: true` with new site ID and dashboard URL.

### `syncMatomo`

- Always uses **`SitesManager.getSitesIdFromSiteUrl`** first.
- If no site exists, it **resets Matomo state** so “Run” becomes available again.
- If a site exists, it calls **`SitesManager.getSiteFromId`** and marks Matomo as **success**.

## Egress (outbound access)

Forge requires explicit egress allowlisting.

- `manifest.yml` includes `https://iit.matomo.cloud` under `permissions.external.fetch.backend`

After adding or changing egress permissions, redeploy and **upgrade** the Forge app install.

## Operational notes / expected behavior

- **Refresh is “state reconciliation”**, not just re-rendering:
  - It can modify the saved issue property (reset Matomo or set it to success).
- **Run is “create or validate”**:
  - It will not create duplicates when a site already exists for that URL, because it looks up by URL first.
- **Existing site selection**:
  - The app currently uses the **first** site ID returned by `getSitesIdFromSiteUrl`.
  - If multiple sites match the same URL, behavior is “first match wins”.
- **On panel load**:
  - `syncMatomo` runs automatically (via the `refresh()` call in `App.js`), so Matomo state is always reconciled against the current URL when the panel opens.
- **Optional Jira field write-back**:
  - If `MATOMO_SITE_ID_FIELD_ID` is set as a Forge environment variable, a successful Run writes the Matomo site ID into that Jira custom field.

## Error handling

The Matomo client treats a response as failed when:

- HTTP status is not OK, or
- JSON body contains `result: "error"` or `status: "error"`

Error messages from Matomo are surfaced in the UI via the `message` / `lastError` fields on the integration row.

Common errors:

| Symptom | Likely cause |
|--------|----------------|
| `401 Unauthorized` | `token_auth` sent via GET instead of POST, or invalid/expired token |
| Permission error on `addSite` | Token is not a superuser token |
| `Failed to check Matomo sites` on load | API call failed during `syncMatomo` (auth, egress, or network) |

## Suggested future hardening (optional)

1. **Move token out of code**
   - Store token in Forge environment variables (e.g., `MATOMO_TOKEN`) and read it at runtime.
2. **Configurable base URL**
   - Read `MATOMO_BASE_URL` from Forge env instead of hardcoding `iit.matomo.cloud`.
3. **Better duplicate detection**
   - If multiple site IDs match the URL, select by exact `main_url` or surface ambiguity in the UI.
4. **Configurable site defaults**
   - Pass `timezone`, `currency`, or `type` to `addSite` if IIT has standard values for new sites.
5. **Avoid failing on load for transient API errors**
   - Distinguish “never run” from “sync failed” so a temporary API error does not overwrite a previously successful state.

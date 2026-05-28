# Better Stack integration (Forge app) — technical documentation

This document describes how the **Better Stack** integration works inside this Forge app (`golive-app`), including the UI flow, backend resolvers, issue-property storage, and Better Stack REST API interactions.

## Overview

The Better Stack integration is implemented **inside the Forge app** (not via the external “go-live API” service used by other integrations).

At a high level:

- The user provides a **Website URL** in the panel (or the app falls back to a Jira Issue “Website URL” field if configured).
- The app checks Better Stack to see whether a monitor already exists for that URL.
- If a monitor exists, the UI is updated to show it.
- If a monitor does not exist, the user can click **Run** to create it.

## Key files

- **Backend (Forge function)**:
  - `src/index.js` — Forge resolver definitions and Jira issue property read/write.
  - `src/betterstack.js` — Better Stack REST API client and integration logic.
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
    "betterstack": {
      "status": "success|failed|running|not_started",
      "label": "Betterstack",
      "id": "123456",
      "url": "https://uptime.betterstack.com/monitors/123456",
      "message": "Human readable status",
      "lastError": "Error message (only when failed)",
      "details": { "monitor": { "...": "..." }, "sla": { "...": "..." } },
      "updatedAt": "2026-05-28T10:00:00.000Z"
    }
  }
}
```

Notes:

- `siteUrlOverride` is written by the panel’s **Save** button.
- `siteUrl` is also stored for convenience/traceability and to keep existing behavior consistent.
- `integrations.betterstack` is written by:
  - `runIntegration` (when the user clicks **Run** for Betterstack)
  - `syncBetterstack` (when the user clicks **Refresh**)

## URL sources and normalization

There are two possible inputs for the URL used by Better Stack:

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

### Refresh button behavior (Better Stack specific)

Pressing **Refresh** performs two actions:

1. Calls `syncBetterstack` (backend) to reconcile Better Stack state for the current URL.
2. Calls `getPanelData` to render the latest state.

This guarantees:

- If no monitor exists anymore (or the URL has changed), the **Betterstack row resets** and the **Run** button becomes available again.
- If a monitor exists, Betterstack is shown as **success** with the ID/link.

### Run button behavior

Clicking **Run** on Betterstack calls `runIntegration({ integration: 'betterstack' })`.

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
- selected configuration env vars (field ids)

### `setSiteUrlOverride`

Payload:

- `siteUrl` (string)

Behavior:

- Normalizes the URL
- Writes `siteUrlOverride` into the issue property
- Returns `{ ok: true, siteUrl: normalized }`

### `syncBetterstack`

No payload; uses the current issue context.

Behavior:

- Resolves the effective `siteUrl` for the issue.
- If `siteUrl` is missing:
  - Clears `integrations.betterstack` state (resets Betterstack in the UI).
- Else, queries Better Stack:
  - If **no monitor** exists:
    - Clears `integrations.betterstack` state (resets Betterstack in the UI).
  - If a **monitor exists**:
    - Optionally calls SLA endpoint (availability summary) and writes Betterstack status to `success`.
  - If Better Stack list call fails:
    - Writes `failed` state with status code + details.

### `runIntegration`

Payload:

- `integration` (string key)

Behavior:

- For Betterstack:
  - Uses `runBetterstackIntegration({ siteUrl, siteName })` from `src/betterstack.js`
  - Writes the final status into the issue property
  - Optionally writes the returned ID into a Jira custom field if `BETTERSTACK_MONITOR_ID_FIELD_ID` is configured.
- For other integrations:
  - Calls the external go-live API service (unchanged behavior).

## Better Stack REST API interactions

All Better Stack API calls are implemented in `src/betterstack.js`.

### Authentication

- Uses an **Authorization Bearer token**.
- Current implementation uses a hardcoded token constant: `BETTERSTACK_TOKEN`.

### Base URL

- `https://uptime.betterstack.com/api/v2`

### Endpoints used

1. **List monitors (filter by URL)**
   - `GET /monitors?url=<siteUrl>`
   - Used to find an existing monitor for the URL.
   - Documentation: Better Stack “List monitors” endpoint.

2. **Monitor availability summary (SLA)**
   - `GET /monitors/{monitor_id}/sla`
   - Used to verify the monitor exists/has a valid SLA response and to show availability in the message.
   - Documentation: “Monitor availability” endpoint.

3. **Create monitor**
   - `POST /monitors`
   - Documentation: “Create monitor” endpoint.
   - Payload used by this app:

```json
{
  "monitor_type": "status",
  "url": "https://example.com",
  "pronounceable_name": "example.com",
  "email": true,
  "sms": false,
  "call": false,
  "check_frequency": 30,
  "verify_ssl": true,
  "follow_redirects": true
}
```

### Monitor naming rule

Monitor name is derived from the URL hostname only:

- `pronounceable_name = new URL(siteUrl).hostname`
- Example: `https://www.example.com/shop` → `www.example.com`

## Integration algorithm (Betterstack)

`runBetterstackIntegration({ siteUrl, siteName })`:

1. Call **list monitors filtered by url**.
2. If monitor exists:
   - Call **SLA** for the monitor id.
   - If SLA succeeds: return `ok: true` and set message with availability if present.
   - If SLA fails: return `ok: false` (treated as failure by the UI/state).
3. If no monitor exists:
   - Call **create monitor**.
   - If created successfully and an id is returned:
     - Call SLA (best effort); if SLA fails it still returns `ok: true` with “pending” message.

`syncBetterstack`:

- Always uses **list monitors filtered by url** first.
- If no monitor exists, it **resets Betterstack state** so “Run” becomes available again.

## Egress (outbound access)

Forge requires explicit egress allowlisting.

- `manifest.yml` includes `https://uptime.betterstack.com` under `permissions.external.fetch.backend`

## Operational notes / expected behavior

- **Refresh is “state reconciliation”**, not just re-rendering:
  - It can modify the saved issue property (reset Betterstack or set it to success).
- **Run is “create or validate”**:
  - It will not create duplicates when a monitor already exists for that URL, because it lists by URL first.
- **Existing monitor selection**:
  - The app currently uses the **first** monitor returned by `GET /monitors?url=...`.
  - If multiple monitors match the same URL, behavior is “first match wins”.

## Suggested future hardening (optional)

1. **Move token out of code**
   - Store token in Forge environment variables (e.g., `BETTERSTACK_TOKEN`) and read it at runtime.
2. **Better duplicate detection**
   - If multiple monitors match the URL, select by exact attributes or surface ambiguity in UI.
3. **Retry/backoff for SLA after create**
   - Newly created monitors may not have SLA ready immediately; SLA call could be retried after a short delay.


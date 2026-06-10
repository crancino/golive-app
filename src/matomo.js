import { fetch } from '@forge/api';

const MATOMO_BASE_URL = 'https://iit.matomo.cloud';
const MATOMO_TOKEN = '46c00572b9e1ae8faf511f9405cca0c4';

/**
 * @see https://developer.matomo.org/guides/querying-the-reporting-api
 */
async function matomoRequest(method, params = {}) {
  // Matomo Cloud requires token_auth as a POST parameter (GET returns 401).
  const body = new URLSearchParams({
    module: 'API',
    method,
    format: 'JSON',
    token_auth: MATOMO_TOKEN,
  });

  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        body.append(`${key}[]`, String(item));
      }
    } else {
      body.set(key, String(value));
    }
  }

  const res = await fetch(`${MATOMO_BASE_URL}/index.php`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = { raw: text };
  }

  const apiError =
    json && typeof json === 'object' && (json.result === 'error' || json.status === 'error')
      ? json.message || 'Matomo API error'
      : null;

  return {
    ok: res.ok && !apiError,
    status: res.status,
    json,
    error: apiError,
  };
}

function siteNameFromUrl(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return u.hostname || siteUrl;
  } catch (e) {
    return siteUrl;
  }
}

function siteDashboardUrl(siteId) {
  return `${MATOMO_BASE_URL}/index.php?module=CoreHome&action=index&idSite=${siteId}`;
}

function formatMatomoError(res) {
  if (res.error) return res.error;
  if (res.json && typeof res.json === 'object' && res.json.message) return res.json.message;
  return `Matomo API error (${res.status})`;
}

/**
 * Returns site IDs matching the given URL.
 * @see https://developer.matomo.org/api-reference/reporting-api-reference (SitesManager.getSitesIdFromSiteUrl)
 */
export async function findSiteIdsByUrl(siteUrl) {
  return matomoRequest('SitesManager.getSitesIdFromSiteUrl', { url: siteUrl });
}

/**
 * Returns site details for a site ID.
 * @see https://developer.matomo.org/api-reference/reporting-api-reference (SitesManager.getSiteFromId)
 */
export async function getSiteFromId(siteId) {
  return matomoRequest('SitesManager.getSiteFromId', { idSite: siteId });
}

/**
 * Creates a new Matomo site.
 * @see https://developer.matomo.org/api-reference/reporting-api-reference (SitesManager.addSite)
 */
export async function createSite(siteUrl, siteName) {
  const name = siteNameFromUrl(siteUrl);
  return matomoRequest('SitesManager.addSite', {
    siteName: name,
    urls: [siteUrl],
  });
}

function parseSiteIds(json) {
  if (Array.isArray(json)) return json.map(String);
  if (json && typeof json === 'object' && Array.isArray(json.value)) {
    return json.value.map(String);
  }
  return [];
}

function parseCreatedSiteId(json) {
  if (typeof json === 'number') return String(json);
  if (typeof json === 'string' && /^\d+$/.test(json)) return json;
  if (json && typeof json === 'object' && json.value != null) return String(json.value);
  return null;
}

/**
 * Ensures a Matomo site exists for the given URL.
 * If a site already exists, verifies it via getSiteFromId.
 * Otherwise creates a new site.
 */
export async function runMatomoIntegration({ siteUrl, siteName }) {
  const listRes = await findSiteIdsByUrl(siteUrl);

  if (!listRes.ok) {
    return {
      integration: 'matomo',
      ok: false,
      message: formatMatomoError(listRes),
      details: listRes.json,
    };
  }

  const siteIds = parseSiteIds(listRes.json);
  const existingId = siteIds[0] || null;

  if (existingId) {
    const siteRes = await getSiteFromId(existingId);

    if (!siteRes.ok) {
      return {
        integration: 'matomo',
        ok: false,
        message: formatMatomoError(siteRes) || `Site exists but lookup failed (${siteRes.status})`,
        details: siteRes.json,
      };
    }

    return {
      integration: 'matomo',
      ok: true,
      id: String(existingId),
      url: siteDashboardUrl(existingId),
      message: 'Matomo site already exists.',
      details: { site: siteRes.json },
    };
  }

  const createRes = await createSite(siteUrl, siteName);

  if (!createRes.ok) {
    return {
      integration: 'matomo',
      ok: false,
      message: formatMatomoError(createRes) || `Failed to create Matomo site (${createRes.status})`,
      details: createRes.json,
    };
  }

  const siteId = parseCreatedSiteId(createRes.json);

  if (!siteId) {
    return {
      integration: 'matomo',
      ok: false,
      message: 'Site created but response did not include an id.',
      details: createRes.json,
    };
  }

  const siteRes = await getSiteFromId(siteId);

  return {
    integration: 'matomo',
    ok: true,
    id: String(siteId),
    url: siteDashboardUrl(siteId),
    message: siteRes.ok ? 'Matomo site created and verified.' : 'Matomo site created.',
    details: { created: createRes.json, site: siteRes.ok ? siteRes.json : null },
  };
}

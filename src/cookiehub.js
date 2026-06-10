import { createHmac } from 'crypto';
import { fetch } from '@forge/api';

const COOKIEHUB_API_BASE = 'https://dash.cookiehub.com/client-api/v2';
const COOKIEHUB_PUBLIC_KEY = '05b6eb44432df172bd8fa99205d07881a09a96f8e64e57e091d597272c1db337';
const COOKIEHUB_PRIVATE_KEY = '2e14690bc244580a3fc3ce3ab59b601a9ff17e992b8e8463af9148ea8ec9c705';

/**
 * Cookiehub Client API auth:
 * signature = HMAC-SHA256(privateKey, "[date].[METHOD].[fullUrl]")
 * Authorization: Bearer [publicKey].[signature]
 * @see https://www.postman.com/dark-spaceship-4473/cookiehub-api/collection/7owf8ij/client-api
 */
function createBearerToken(method, url) {
  const date = new Date().toISOString().slice(0, 10);
  const message = `${date}.${method}.${url}`;
  const signature = createHmac('sha256', COOKIEHUB_PRIVATE_KEY).update(message).digest('hex');
  return `${COOKIEHUB_PUBLIC_KEY}.${signature}`;
}

async function cookiehubRequest(method, path, init = {}) {
  const url = path.startsWith('http') ? path : `${COOKIEHUB_API_BASE}${path}`;
  const token = createBearerToken(method, url);

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    ...init,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = { raw: text };
  }

  return { ok: res.ok, status: res.status, json };
}

export function domainNameFromUrl(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return (u.hostname || siteUrl).toLowerCase();
  } catch (e) {
    return String(siteUrl).toLowerCase();
  }
}

function domainDashboardUrl(domainId) {
  return `https://dash.cookiehub.com/domain/${domainId}`;
}

function normalizeDomainName(name) {
  return String(name || '').trim().toLowerCase();
}

function formatCookiehubError(res) {
  if (res.json && typeof res.json === 'object') {
    if (res.json.error) return String(res.json.error);
    if (res.json.message) return String(res.json.message);
  }
  return `Cookiehub API error (${res.status})`;
}

function isAlreadyExistsError(res) {
  const err = res.json?.error || '';
  return /already exists/i.test(String(err));
}

/**
 * Lists domains from the account. Fetches page 1 and, when supported, additional pages.
 */
export async function listDomains() {
  const allItems = [];
  let pages = 1;

  const firstRes = await cookiehubRequest('GET', '/domain');
  if (!firstRes.ok) {
    return { ok: false, status: firstRes.status, json: firstRes.json, items: [] };
  }

  const firstItems = firstRes.json?.items || [];
  allItems.push(...firstItems);
  pages = firstRes.json?.pagination?.pages || 1;

  for (let page = 2; page <= pages; page += 1) {
    const pageUrl = `${COOKIEHUB_API_BASE}/domain?current=${page}`;
    const pageRes = await cookiehubRequest('GET', pageUrl);
    if (!pageRes.ok) break;
    const pageItems = pageRes.json?.items || [];
    allItems.push(...pageItems);
  }

  return { ok: true, status: 200, json: firstRes.json, items: allItems };
}

/**
 * Finds a domain in the account by hostname.
 */
export async function findDomainByName(domainName) {
  const target = normalizeDomainName(domainName);
  const listRes = await listDomains();

  if (!listRes.ok) {
    return { ok: false, status: listRes.status, json: listRes.json, domain: null };
  }

  const domain =
    listRes.items.find((item) => normalizeDomainName(item?.name) === target) || null;

  return { ok: true, status: 200, json: listRes.json, domain };
}

/**
 * Returns detailed information for a domain by ID.
 */
export async function getDomainById(domainId) {
  return cookiehubRequest('GET', `/domain/${encodeURIComponent(domainId)}`);
}

/**
 * Verifies a domain exists by ID and matches the expected hostname.
 * Used when the paginated list does not include the domain yet.
 */
export async function verifyDomainById(domainId, domainName) {
  const detailRes = await getDomainById(domainId);
  if (!detailRes.ok) {
    return { ok: false, domain: null, details: detailRes.json };
  }

  const detailName = normalizeDomainName(detailRes.json?.name);
  if (detailName !== normalizeDomainName(domainName)) {
    return { ok: false, domain: null, details: detailRes.json };
  }

  return { ok: true, domain: detailRes.json, id: String(domainId) };
}

/**
 * Creates a new Cookiehub domain project.
 */
export async function createDomain(domainName) {
  const name = normalizeDomainName(domainName);
  return cookiehubRequest('POST', '/domain', {
    body: JSON.stringify({ name }),
  });
}

function parseCreatedDomainId(json) {
  if (!json?.id) return null;
  if (json.success === true || json.success === 'true') return String(json.id);
  if (!json.error && Number(json.id) > 0) return String(json.id);
  return null;
}

/**
 * Ensures a Cookiehub domain project exists for the site URL.
 */
export async function runCookiehubIntegration({ siteUrl }) {
  const domainName = domainNameFromUrl(siteUrl);

  const findRes = await findDomainByName(domainName);
  if (!findRes.ok) {
    return {
      integration: 'cookiehub',
      ok: false,
      message: formatCookiehubError(findRes),
      details: findRes.json,
    };
  }

  if (findRes.domain?.id) {
    const domainId = String(findRes.domain.id);
    const detailRes = await getDomainById(domainId);

    return {
      integration: 'cookiehub',
      ok: true,
      id: domainId,
      url: domainDashboardUrl(domainId),
      message: 'Cookiehub domain already exists.',
      details: { domain: detailRes.ok ? detailRes.json : findRes.domain },
    };
  }

  const createRes = await createDomain(domainName);

  if (createRes.ok) {
    const domainId = parseCreatedDomainId(createRes.json);
    if (domainId) {
      const detailRes = await getDomainById(domainId);
      return {
        integration: 'cookiehub',
        ok: true,
        id: domainId,
        url: domainDashboardUrl(domainId),
        message: detailRes.ok ? 'Cookiehub domain created and verified.' : 'Cookiehub domain created.',
        details: { created: createRes.json, domain: detailRes.ok ? detailRes.json : null },
      };
    }
  }

  if (isAlreadyExistsError(createRes)) {
    const retryFind = await findDomainByName(domainName);
    if (retryFind.domain?.id) {
      const domainId = String(retryFind.domain.id);
      return {
        integration: 'cookiehub',
        ok: true,
        id: domainId,
        url: domainDashboardUrl(domainId),
        message: 'Cookiehub domain already exists.',
        details: { domain: retryFind.domain },
      };
    }

    return {
      integration: 'cookiehub',
      ok: true,
      id: null,
      url: 'https://dash.cookiehub.com/',
      message: `Cookiehub domain ${domainName} already exists.`,
      details: createRes.json,
    };
  }

  return {
    integration: 'cookiehub',
    ok: false,
    message: formatCookiehubError(createRes),
    details: createRes.json,
  };
}

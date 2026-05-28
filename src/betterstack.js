import { fetch } from '@forge/api';

const BETTERSTACK_API_BASE = 'https://uptime.betterstack.com/api/v2';
const BETTERSTACK_TOKEN = 'c8ZcSKNuEZzfQEq2neEbYAt4';

async function betterstackRequest(path, init = {}) {
  const res = await fetch(`${BETTERSTACK_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${BETTERSTACK_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
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

/**
 * Returns availability summary for a monitor (SLA endpoint).
 * @see https://betterstack.com/docs/uptime/api/get-a-monitors-availability-summary/
 */
export async function getMonitorAvailability(monitorId) {
  return betterstackRequest(`/monitors/${encodeURIComponent(monitorId)}/sla`);
}

/**
 * Finds an existing monitor for the given site URL.
 * @see https://betterstack.com/docs/uptime/api/list-all-existing-monitors/
 */
export async function findMonitorByUrl(siteUrl) {
  const qs = new URLSearchParams({ url: siteUrl });
  return betterstackRequest(`/monitors?${qs.toString()}`);
}

function monitorNameFromUrl(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return u.hostname || siteUrl;
  } catch (e) {
    return siteUrl;
  }
}

/**
 * Creates a new HTTP status monitor.
 * @see https://betterstack.com/docs/uptime/api/create-a-new-monitor/
 */
export async function createMonitor(siteUrl, siteName) {
  const monitorName = monitorNameFromUrl(siteUrl);
  const body = {
    monitor_type: 'status',
    url: siteUrl,
    pronounceable_name: monitorName,
    email: true,
    sms: false,
    call: false,
    check_frequency: 30,
    verify_ssl: true,
    follow_redirects: true,
  };

  return betterstackRequest('/monitors', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function formatBetterstackErrors(json) {
  if (!json) return 'Better Stack API error';
  if (typeof json.errors === 'string') return json.errors;
  if (json.errors && typeof json.errors === 'object') {
    const parts = Object.entries(json.errors).flatMap(([key, values]) => {
      const list = Array.isArray(values) ? values : [values];
      return list.map((v) => (key === 'base' ? v : `${key}: ${v}`));
    });
    if (parts.length) return parts.join('; ');
  }
  return 'Better Stack API error';
}

function monitorDashboardUrl(monitorId) {
  return `https://uptime.betterstack.com/monitors/${monitorId}`;
}

/**
 * Ensures a Better Stack uptime monitor exists for the site URL.
 * If a monitor already exists, verifies it via the availability (SLA) endpoint.
 * Otherwise creates a new monitor when the API calls succeed.
 */
export async function runBetterstackIntegration({ siteUrl, siteName }) {
  const listRes = await findMonitorByUrl(siteUrl);

  if (!listRes.ok) {
    return {
      integration: 'betterstack',
      ok: false,
      message: formatBetterstackErrors(listRes.json) || `Failed to list monitors (${listRes.status})`,
      details: listRes.json,
    };
  }

  const existing = listRes.json?.data?.[0] || null;

  if (existing?.id) {
    const slaRes = await getMonitorAvailability(existing.id);

    if (!slaRes.ok) {
      return {
        integration: 'betterstack',
        ok: false,
        message:
          formatBetterstackErrors(slaRes.json) ||
          `Monitor exists but availability check failed (${slaRes.status})`,
        details: slaRes.json,
      };
    }

    const availability = slaRes.json?.data?.attributes?.availability ?? null;

    return {
      integration: 'betterstack',
      ok: true,
      id: String(existing.id),
      url: monitorDashboardUrl(existing.id),
      message:
        availability != null
          ? `Monitor already exists (${availability}% availability).`
          : 'Monitor already exists.',
      details: { monitor: existing, sla: slaRes.json },
    };
  }

  const createRes = await createMonitor(siteUrl, siteName);

  if (!createRes.ok) {
    return {
      integration: 'betterstack',
      ok: false,
      message: formatBetterstackErrors(createRes.json) || `Failed to create monitor (${createRes.status})`,
      details: createRes.json,
    };
  }

  const created = createRes.json?.data;
  const monitorId = created?.id;

  if (!monitorId) {
    return {
      integration: 'betterstack',
      ok: false,
      message: 'Monitor created but response did not include an id.',
      details: createRes.json,
    };
  }

  const slaRes = await getMonitorAvailability(monitorId);

  return {
    integration: 'betterstack',
    ok: true,
    id: String(monitorId),
    url: monitorDashboardUrl(monitorId),
    message: slaRes.ok
      ? 'Monitor created and availability verified.'
      : 'Monitor created (availability summary pending).',
    details: { monitor: created, sla: slaRes.ok ? slaRes.json : null },
  };
}

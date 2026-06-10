import Resolver from '@forge/resolver';
import api, { fetch, route } from '@forge/api';
import {
  runBetterstackIntegration,
  findMonitorByUrl,
  getMonitorAvailability,
} from './betterstack.js';
import {
  runMatomoIntegration,
  findSiteIdsByUrl,
  getSiteFromId,
} from './matomo.js';
import {
  runCookiehubIntegration,
  findDomainByName,
  getDomainById,
  verifyDomainById,
  domainNameFromUrl,
} from './cookiehub.js';

const resolver = new Resolver();

const ISSUE_PROPERTY_KEY = 'forge.goLiveIntegrations';

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing Forge env var: ${name}`);
  }
  return v;
}

function integrationLabel(key) {
  switch (key) {
    case 'cookiehub':
      return 'Cookiehub';
    case 'matomo':
      return 'Matomo';
    case 'mysitesguru':
      return 'mysites.guru';
    case 'betterstack':
      return 'Betterstack';
    case 'ahrefs':
      return 'Ahrefs';
    default:
      return key;
  }
}

async function jiraJson(jiraRoute, init = {}) {
  const res = await api.asApp().requestJira(jiraRoute, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (json && (json.errorMessages?.join('; ') || json.message)) ||
      `Jira API error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function getIssue(issueKey) {
  // Keep fields minimal; Website URL field is a customfield id supplied via env.
  const websiteUrlFieldId = process.env.WEBSITE_URL_FIELD_ID;
  const fields = ['summary'];
  if (websiteUrlFieldId) fields.push(websiteUrlFieldId);
  const qs = fields.join(',');
  return await jiraJson(route`/rest/api/3/issue/${issueKey}?fields=${qs}`);
}

async function getIssueProperty(issueKey) {
  try {
    return await jiraJson(
      route`/rest/api/3/issue/${issueKey}/properties/${ISSUE_PROPERTY_KEY}`
    );
  } catch (e) {
    return null;
  }
}

async function setIssueProperty(issueKey, value) {
  await jiraJson(route`/rest/api/3/issue/${issueKey}/properties/${ISSUE_PROPERTY_KEY}`, {
    method: 'PUT',
    body: JSON.stringify(value),
  });
}

async function updateIssueFields(issueKey, fields) {
  await jiraJson(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
}

function mergeIntegrationResult(existing, integrationKey, patch) {
  const base = existing && existing.integrations ? existing : { integrations: {} };
  const next = {
    ...(base || {}),
    integrations: {
      ...(base.integrations || {}),
      [integrationKey]: {
        ...(base.integrations?.[integrationKey] || {}),
        ...patch,
        updatedAt: nowIso(),
      },
    },
  };
  return next;
}

function clearIntegration(existing, integrationKey) {
  const base = existing && existing.integrations ? existing : { integrations: {} };
  const next = {
    ...(base || {}),
    integrations: {
      ...(base.integrations || {}),
    },
  };
  if (next.integrations && next.integrations[integrationKey]) {
    delete next.integrations[integrationKey];
  }
  return next;
}

function normalizeSiteUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`);
    return u.toString().replace(/\/$/, '');
  } catch (e) {
    return null;
  }
}

function getSiteUrlFromIssue(issue) {
  const websiteUrlFieldId = process.env.WEBSITE_URL_FIELD_ID;
  if (websiteUrlFieldId && issue?.fields?.[websiteUrlFieldId]) {
    const v = issue.fields[websiteUrlFieldId];
    // Jira URL field can come through as string.
    if (typeof v === 'string') return normalizeSiteUrl(v);
    // Some field types can be objects; best effort.
    if (v && typeof v === 'object' && typeof v.value === 'string') return normalizeSiteUrl(v.value);
  }
  return null;
}

function getSiteUrlOverrideFromState(state) {
  const v = state?.siteUrlOverride ?? null;
  return normalizeSiteUrl(v);
}

async function getEffectiveSiteContext(issueKey) {
  const [issue, prop] = await Promise.all([getIssue(issueKey), getIssueProperty(issueKey)]);
  const siteName = issue?.fields?.summary || '';
  const state = (prop && prop.value) || null;
  const override = getSiteUrlOverrideFromState(state);
  const fromIssue = getSiteUrlFromIssue(issue);
  const siteUrl = override || fromIssue || null;
  return { issue, state, siteName, siteUrl };
}

async function callGoLiveService(payload) {
  const baseUrl = requireEnv('GO_LIVE_API_BASE_URL').replace(/\/$/, '');
  const apiKey = requireEnv('GO_LIVE_API_KEY');
  const res = await fetch(`${baseUrl}/integrations/run`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = { ok: false, message: text || 'Non-JSON response from service' };
  }
  if (!res.ok) {
    return {
      integration: payload.integration,
      ok: false,
      message: (json && json.message) || `Service error ${res.status}`,
      details: json,
    };
  }
  return json;
}

function betterstackDashboardUrl(monitorId) {
  return `https://uptime.betterstack.com/monitors/${monitorId}`;
}

function matomoDashboardUrl(siteId) {
  return `https://iit.matomo.cloud/index.php?module=CoreHome&action=index&idSite=${siteId}`;
}

function cookiehubDashboardUrl(domainId) {
  return `https://dash.cookiehub.com/domain/${domainId}`;
}

function parseMatomoSiteIds(json) {
  if (Array.isArray(json)) return json.map(String);
  if (json && typeof json === 'object' && Array.isArray(json.value)) {
    return json.value.map(String);
  }
  return [];
}

resolver.define('getPanelData', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  const projectKey = req?.context?.extension?.project?.key;
  if (!issueKey) throw new Error('Missing issue context');

  const { state, siteName, siteUrl } = await getEffectiveSiteContext(issueKey);
  const integrations = state?.integrations || {};

  return {
    issueKey,
    projectKey,
    siteName,
    siteUrl,
    siteUrlOverride: state?.siteUrlOverride || null,
    propertyKey: ISSUE_PROPERTY_KEY,
    integrations,
    config: {
      websiteUrlFieldId: process.env.WEBSITE_URL_FIELD_ID || null,
      matomoSiteIdFieldId: process.env.MATOMO_SITE_ID_FIELD_ID || null,
      betterstackMonitorIdFieldId: process.env.BETTERSTACK_MONITOR_ID_FIELD_ID || null,
      cookiehubSiteIdFieldId: process.env.COOKIEHUB_SITE_ID_FIELD_ID || null,
    },
  };
});

resolver.define('setSiteUrlOverride', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  const raw = req?.payload?.siteUrl;
  if (!issueKey) throw new Error('Missing issue context');

  const normalized = normalizeSiteUrl(raw);
  if (!normalized) {
    throw new Error('Please enter a valid website URL or domain (e.g. example.com).');
  }

  const existingProp = await getIssueProperty(issueKey);
  const existingState = (existingProp && existingProp.value) || { integrations: {} };
  const nextState = { ...existingState, siteUrlOverride: normalized };
  await setIssueProperty(issueKey, nextState);

  return { ok: true, siteUrl: normalized };
});

resolver.define('syncCookiehub', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  if (!issueKey) throw new Error('Missing issue context');

  const { state, siteUrl } = await getEffectiveSiteContext(issueKey);
  if (!siteUrl) {
    const reset = clearIntegration(state || { integrations: {} }, 'cookiehub');
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl: null, exists: false, reset: true };
  }

  const domainName = domainNameFromUrl(siteUrl);
  const findRes = await findDomainByName(domainName);
  if (!findRes.ok) {
    const failed = mergeIntegrationResult(state || { integrations: {} }, 'cookiehub', {
      status: 'failed',
      label: integrationLabel('cookiehub'),
      id: null,
      url: null,
      message: `Failed to check Cookiehub domains (${findRes.status}).`,
      lastError: `Failed to check Cookiehub domains (${findRes.status}).`,
      details: findRes.json,
    });
    failed.siteUrl = siteUrl;
    await setIssueProperty(issueKey, failed);
    return { ok: false, exists: null };
  }

  let existing = findRes.domain;
  if (!existing?.id) {
    // New domains may not appear on the first list page (pagination limits).
    // Fall back to the stored domain id from a recent successful Run.
    const storedId = state?.integrations?.cookiehub?.id;
    if (storedId) {
      const verifyRes = await verifyDomainById(storedId, domainName);
      if (verifyRes.ok) {
        existing = { id: verifyRes.id, name: domainName };
      }
    }
  }

  if (!existing?.id) {
    const reset = clearIntegration(state || { integrations: {} }, 'cookiehub');
    reset.siteUrl = siteUrl;
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl, exists: false, reset: true };
  }

  const domainId = String(existing.id);
  const detailRes = await getDomainById(domainId);

  const success = mergeIntegrationResult(state || { integrations: {} }, 'cookiehub', {
    status: 'success',
    label: integrationLabel('cookiehub'),
    id: domainId,
    url: cookiehubDashboardUrl(domainId),
    message: `Cookiehub domain exists (${domainName}).`,
    lastError: null,
    details: { domain: detailRes.ok ? detailRes.json : existing },
  });
  success.siteUrl = siteUrl;
  await setIssueProperty(issueKey, success);

  return { ok: true, siteUrl, exists: true, id: domainId };
});

resolver.define('syncMatomo', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  if (!issueKey) throw new Error('Missing issue context');

  const { state, siteUrl } = await getEffectiveSiteContext(issueKey);
  if (!siteUrl) {
    const reset = clearIntegration(state || { integrations: {} }, 'matomo');
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl: null, exists: false, reset: true };
  }

  const listRes = await findSiteIdsByUrl(siteUrl);
  if (!listRes.ok) {
    const failed = mergeIntegrationResult(state || { integrations: {} }, 'matomo', {
      status: 'failed',
      label: integrationLabel('matomo'),
      id: null,
      url: null,
      message: `Failed to check Matomo sites (${listRes.status}).`,
      lastError: `Failed to check Matomo sites (${listRes.status}).`,
      details: listRes.json,
    });
    failed.siteUrl = siteUrl;
    await setIssueProperty(issueKey, failed);
    return { ok: false, exists: null };
  }

  const siteIds = parseMatomoSiteIds(listRes.json);
  const existingId = siteIds[0] || null;

  if (!existingId) {
    const reset = clearIntegration(state || { integrations: {} }, 'matomo');
    reset.siteUrl = siteUrl;
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl, exists: false, reset: true };
  }

  const siteRes = await getSiteFromId(existingId);
  const siteName = siteRes.ok ? siteRes.json?.name || null : null;

  const success = mergeIntegrationResult(state || { integrations: {} }, 'matomo', {
    status: 'success',
    label: integrationLabel('matomo'),
    id: String(existingId),
    url: matomoDashboardUrl(existingId),
    message: siteName ? `Matomo site exists (${siteName}).` : 'Matomo site exists.',
    lastError: null,
    details: { site: siteRes.ok ? siteRes.json : null },
  });
  success.siteUrl = siteUrl;
  await setIssueProperty(issueKey, success);

  return { ok: true, siteUrl, exists: true, id: String(existingId) };
});

resolver.define('syncBetterstack', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  if (!issueKey) throw new Error('Missing issue context');

  const { state, siteName, siteUrl } = await getEffectiveSiteContext(issueKey);
  if (!siteUrl) {
    // No URL => reset Betterstack integration to default.
    const reset = clearIntegration(state || { integrations: {} }, 'betterstack');
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl: null, exists: false, reset: true };
  }

  const listRes = await findMonitorByUrl(siteUrl);
  if (!listRes.ok) {
    const failed = mergeIntegrationResult(state || { integrations: {} }, 'betterstack', {
      status: 'failed',
      label: integrationLabel('betterstack'),
      id: null,
      url: null,
      message: `Failed to check Betterstack monitors (${listRes.status}).`,
      lastError: `Failed to check Betterstack monitors (${listRes.status}).`,
      details: listRes.json,
    });
    failed.siteUrl = siteUrl;
    await setIssueProperty(issueKey, failed);
    return { ok: false, exists: null };
  }

  const existing = listRes.json?.data?.[0] || null;
  if (!existing?.id) {
    // No monitor exists => reset Betterstack row to default and re-enable Run.
    const reset = clearIntegration(state || { integrations: {} }, 'betterstack');
    reset.siteUrl = siteUrl;
    await setIssueProperty(issueKey, reset);
    return { ok: true, siteUrl, exists: false, reset: true };
  }

  // Monitor exists => verify availability summary (SLA). If SLA fails, we still consider it "exists".
  const slaRes = await getMonitorAvailability(existing.id);
  const availability = slaRes.ok ? slaRes.json?.data?.attributes?.availability ?? null : null;

  const success = mergeIntegrationResult(state || { integrations: {} }, 'betterstack', {
    status: 'success',
    label: integrationLabel('betterstack'),
    id: String(existing.id),
    url: betterstackDashboardUrl(existing.id),
    message:
      availability != null
        ? `Monitor exists (${availability}% availability).`
        : 'Monitor exists.',
    lastError: null,
    details: { monitor: existing, sla: slaRes.ok ? slaRes.json : null },
  });
  success.siteUrl = siteUrl;
  await setIssueProperty(issueKey, success);

  return { ok: true, siteUrl, exists: true, id: String(existing.id) };
});

resolver.define('runIntegration', async (req) => {
  const issueKey = req?.context?.extension?.issue?.key;
  const projectKey = req?.context?.extension?.project?.key;
  const integration = req?.payload?.integration;
  if (!issueKey) throw new Error('Missing issue context');
  if (!integration) throw new Error('Missing integration key');
  if (integration === 'ahrefs') {
    return {
      integration,
      ok: true,
      id: null,
      message: 'Ahrefs is a manual-only step (no API automation).',
    };
  }

  const { siteName, siteUrl } = await getEffectiveSiteContext(issueKey);
  if (!siteUrl) {
    throw new Error(
      `Missing Website URL. Either set it on the issue (WEBSITE_URL_FIELD_ID) or enter it in the panel.`
    );
  }

  // Mark as running in property for immediate UI feedback.
  const existingProp = await getIssueProperty(issueKey);
  const existingState = (existingProp && existingProp.value) || {
    siteUrl,
    integrations: {},
  };
  const runningState = mergeIntegrationResult(existingState, integration, {
    status: 'running',
    label: integrationLabel(integration),
    lastError: null,
    message: 'Running…',
  });
  runningState.siteUrl = siteUrl;
  await setIssueProperty(issueKey, runningState);

  let result;
  if (integration === 'betterstack') {
    result = await runBetterstackIntegration({ siteUrl, siteName });
  } else if (integration === 'matomo') {
    result = await runMatomoIntegration({ siteUrl, siteName });
  } else if (integration === 'cookiehub') {
    result = await runCookiehubIntegration({ siteUrl, siteName });
  } else {
    const payload = {
      integration,
      issueKey,
      projectKey,
      siteUrl,
      siteName,
    };
    result = await callGoLiveService(payload);
  }

  const status = result.ok ? 'success' : 'failed';
  const patch = {
    status,
    id: result.id || null,
    url: result.url || null,
    message: result.message || (result.ok ? 'Success' : 'Failed'),
    lastError: result.ok ? null : result.message || 'Failed',
    details: result.details || null,
  };

  const latestProp = await getIssueProperty(issueKey);
  const latestState = (latestProp && latestProp.value) || existingState;
  const nextState = mergeIntegrationResult(latestState, integration, patch);
  nextState.siteUrl = siteUrl;
  await setIssueProperty(issueKey, nextState);

  // Optional: write returned IDs into human-visible custom fields.
  const fieldUpdates = {};
  if (result.ok && result.id) {
    if (integration === 'matomo' && process.env.MATOMO_SITE_ID_FIELD_ID) {
      fieldUpdates[process.env.MATOMO_SITE_ID_FIELD_ID] = String(result.id);
    }
    if (integration === 'betterstack' && process.env.BETTERSTACK_MONITOR_ID_FIELD_ID) {
      fieldUpdates[process.env.BETTERSTACK_MONITOR_ID_FIELD_ID] = String(result.id);
    }
    if (integration === 'cookiehub' && process.env.COOKIEHUB_SITE_ID_FIELD_ID) {
      fieldUpdates[process.env.COOKIEHUB_SITE_ID_FIELD_ID] = String(result.id);
    }
  }
  if (Object.keys(fieldUpdates).length) {
    await updateIssueFields(issueKey, fieldUpdates);
  }

  return { ...result, status };
});

export const handler = resolver.getDefinitions();

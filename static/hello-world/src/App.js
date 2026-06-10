import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

function App() {
  const [panel, setPanel] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);
  const [siteUrlInput, setSiteUrlInput] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // On refresh, reconcile integration state against current URL.
      await invoke('syncCookiehub', {});
      await invoke('syncMatomo', {});
      await invoke('syncBetterstack', {});
      const data = await invoke('getPanelData', {});
      setPanel(data);
      setSiteUrlInput((prev) => (prev ? prev : data?.siteUrlOverride || data?.siteUrl || ''));
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (integration) => {
    setError(null);
    setBusyKey(integration);
    try {
      await invoke('runIntegration', { integration });
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const saveSiteUrl = async () => {
    setError(null);
    setSavingUrl(true);
    try {
      await invoke('setSiteUrlOverride', { siteUrl: siteUrlInput });
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setSavingUrl(false);
    }
  };

  const integrationsOrder = [
    { key: 'cookiehub', label: 'Cookiehub', automated: true },
    { key: 'matomo', label: 'Matomo', automated: true },
    { key: 'mysitesguru', label: 'mysites.guru', automated: true },
    { key: 'betterstack', label: 'Betterstack', automated: true },
    { key: 'ahrefs', label: 'Ahrefs', automated: false },
  ];

  const rowFor = (key) => panel?.integrations?.[key] || { status: 'not_started' };

  const statusPillStyle = (status) => {
    const base = {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 12,
      border: '1px solid transparent',
      whiteSpace: 'nowrap',
    };
    switch (status) {
      case 'success':
        return { ...base, background: '#E3FCEF', borderColor: '#ABF5D1', color: '#006644' };
      case 'failed':
        return { ...base, background: '#FFEBE6', borderColor: '#FFBDAD', color: '#BF2600' };
      case 'running':
        return { ...base, background: '#DEEBFF', borderColor: '#B3D4FF', color: '#0747A6' };
      case 'manual':
        return { ...base, background: '#EAE6FF', borderColor: '#C0B6F2', color: '#403294' };
      default:
        return { ...base, background: '#F4F5F7', borderColor: '#DFE1E6', color: '#42526E' };
    }
  };

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Go live integrations</div>
          <div style={{ fontSize: 12, color: '#6B778C' }}>
            {panel?.issueKey ? (
              <>
                Issue <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>{panel.issueKey}</span>
                {panel.siteUrl ? (
                  <>
                    {' '}
                    · Site <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>{panel.siteUrl}</span>
                  </>
                ) : null}
              </>
            ) : (
              'Loading…'
            )}
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={!panel || busyKey}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #DFE1E6',
            background: '#FFFFFF',
            cursor: !panel || busyKey ? 'not-allowed' : 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      <div style={{ marginTop: 12, padding: 10, border: '1px solid #DFE1E6', borderRadius: 8, background: '#FFFFFF' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#42526E', marginBottom: 6 }}>Website URL</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={siteUrlInput}
            onChange={(e) => setSiteUrlInput(e.target.value)}
            placeholder="example.com or https://example.com"
            disabled={!panel || busyKey || savingUrl}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #DFE1E6',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
            }}
          />
          <button
            onClick={saveSiteUrl}
            disabled={!panel || busyKey || savingUrl || !siteUrlInput.trim()}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #DFE1E6',
              background: '#FFFFFF',
              cursor: !panel || busyKey || savingUrl || !siteUrlInput.trim() ? 'not-allowed' : 'pointer',
              opacity: !panel || busyKey || savingUrl || !siteUrlInput.trim() ? 0.7 : 1,
            }}
          >
            {savingUrl ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#6B778C' }}>
          This overrides the issue field (and is saved per issue). Cookiehub, Matomo, and Betterstack use this value.
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 12, padding: 10, background: '#FFEBE6', border: '1px solid #FFBDAD', borderRadius: 6, color: '#BF2600' }}>
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: 12, border: '1px solid #DFE1E6', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 0.9fr 1.2fr 1fr', gap: 0, background: '#F4F5F7', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: '#42526E' }}>
          <div>Integration</div>
          <div>Status</div>
          <div>ID / Link</div>
          <div style={{ textAlign: 'right' }}>Action</div>
        </div>

        {integrationsOrder.map((i) => {
          const r = rowFor(i.key);
          const status = r.status || (i.automated ? 'not_started' : 'manual');
          const id = r.id || null;
          const url = r.url || null;
          const message = r.message || r.lastError || null;

          const isBusy = busyKey === i.key;
          const canRun = i.automated && status !== 'success' && !busyKey;
          const actionLabel = status === 'success' ? 'Done' : isBusy ? 'Running…' : 'Run';

          return (
            <div
              key={i.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 0.9fr 1.2fr 1fr',
                gap: 0,
                padding: '10px 12px',
                borderTop: '1px solid #DFE1E6',
                alignItems: 'center',
                fontSize: 13,
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{i.label}</div>
                {i.key === 'ahrefs' ? (
                  <div style={{ fontSize: 12, color: '#6B778C', marginTop: 2 }}>
                    Manual-only (no API automation).
                  </div>
                ) : message ? (
                  <div style={{ fontSize: 12, color: status === 'failed' ? '#BF2600' : '#6B778C', marginTop: 2 }}>
                    {message}
                  </div>
                ) : null}
              </div>

              <div>
                <span style={statusPillStyle(status)}>{status}</span>
              </div>

              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" style={{ color: '#0052CC', textDecoration: 'none' }}>
                    {id ? `${id}` : 'Open'}
                  </a>
                ) : id ? (
                  id
                ) : (
                  <span style={{ color: '#6B778C' }}>—</span>
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                {i.automated ? (
                  <button
                    onClick={() => run(i.key)}
                    disabled={!canRun}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid #DFE1E6',
                      background: status === 'success' ? '#F4F5F7' : '#0052CC',
                      color: status === 'success' ? '#6B778C' : '#FFFFFF',
                      cursor: canRun ? 'pointer' : 'not-allowed',
                      opacity: canRun ? 1 : 0.7,
                    }}
                  >
                    {actionLabel}
                  </button>
                ) : (
                  <span style={{ color: '#6B778C', fontSize: 12 }}>Manual</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!panel?.siteUrl ? (
        <div style={{ marginTop: 12, fontSize: 12, color: '#6B778C' }}>
          Tip: set <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>WEBSITE_URL_FIELD_ID</span> and populate the Website URL field on the issue.
        </div>
      ) : null}
    </div>
  );
}

export default App;

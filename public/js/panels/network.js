/**
 * Network — personal CRM for friends and business contacts.
 * @param {HTMLElement | null} root
 */
export function mountNetwork(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'network-app';
  wrap.innerHTML = '<p class="muted">Loading contacts…</p>';
  root.append(wrap);

  // Full UI is attached after API modules land; this stub is replaced in network-ui step.
  // Cache-bust query so avatar clear-button removals always land after rebuilds.
  import('./network-ui.js?v=kids-birth-years-1')
    .then(({ mountNetworkUi }) => {
      // #region agent log
      const payload = {
        sessionId: 'e55622',
        runId: 'post-fix',
        hypothesisId: 'A',
        location: 'network.js:import',
        message: 'network-ui module loaded',
        data: { buildTag: 'birthday-row-2' },
        timestamp: Date.now(),
      };
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e55622' },
        body: JSON.stringify(payload),
      }).catch(() => {});
      fetch('/api/dev-agent-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
      // #endregion
      mountNetworkUi(wrap);
    })
    .catch((e) => {
      console.error('Network UI mount failed:', e);
      wrap.replaceChildren();
      const err = document.createElement('p');
      err.className = 'muted';
      err.textContent = 'Could not load Network.';
      wrap.append(err);
    });
}

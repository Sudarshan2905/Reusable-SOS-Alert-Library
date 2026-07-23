/* ============================================================
   sos.js — SOS Emergency Alert Library
   Reusable, self-contained widget. Ships alongside sos.css on
   CloudFront and is included on any ERP page after core.js /
   utils.js:

     <link rel="stylesheet" href="sos.css">
     <script src="core.js"></script>
     <script src="utils.js"></script>
     <script src="sos.js"></script>

   Usage:
     <button id="btnSOS">SOS</button>
     <script>
       SOS.init({ button: '#btnSOS', machineId: 'ST1' });
     </script>

   Exposes exactly one global: window.SOS
   Everything else is private to this closure.

   Reuses apiCall() / openToast() from utils.js when present.
   Falls back to raw fetch() / a lightweight toast if utils.js
   is not loaded on the page, so this file has no hard
   dependency on utils.js — it only prefers it.
   ============================================================ */

const SOS = (() => {
  'use strict';

  // ==========================================================
  // PRIVATE STATE
  // ==========================================================
  let config = {
    button: null,          // CSS selector or Element
    machineId: '',         // string or () => string
    apiBase: '/app',       // base path — GET {apiBase}/sos-alerts, POST {apiBase}/sos-alert
    getAlertsUrl: null,    // full override for the GET url
    postAlertUrl: null,    // full override for the POST url
    cacheDuration: 300000, // ms to reuse a cached GET /sos-alerts response (default 5 min; 0 disables caching)
    debug: false,          // when true, prints internal diagnostics via log()
    onSuccess: null,       // optional (data) => {} called after a successful POST /sos-alert
    onError: null,         // optional (err) => {} called after a failed GET or POST
  };

  let els = {
    triggerBtn: null,
    overlay: null,
    modal: null,
    grid: null,
    sendBtn: null,
    closeBtn: null,
    otherWrapper: null, // wrapper around the free-text "Other" input
    otherInput: null,   // the free-text "Other" input itself
    otherCounter: null, // "N / 150" live counter
    otherError: null,   // NEW — inline red error message under the input
  };

  let state = {
    alerts: [],
    selectedAlert: null,
    selectedIsCustom: false, // companion flag for isOtherAlert()
    isLoading: false,
    isSending: false,
    initialized: false,
    cacheTimestamp: 0,     // Date.now() of the last successful GET, for cacheDuration
    abortController: null, // aborts an in-flight GET if the modal closes first
  };

  let lastFocusedEl = null;

  // ==========================================================
  // PRIVATE HELPERS
  // ==========================================================

  /** Escapes text before it is ever placed into innerHTML. */
  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  };

  /** Resolves the current machine id — supports a static value or a function. */
  const resolveMachineId = () => {
    return typeof config.machineId === 'function'
      ? config.machineId()
      : config.machineId;
  };

  /** Gated debug logger. Silent unless SOS.init({ debug: true }) was set. */
  const log = (...args) => {
    if (config.debug) console.log('[SOS]', ...args);
  };

  /**
   * True if an alert entry requires the free-text "Other" flow.
   * Prefers explicit backend metadata ({ alert, custom: true }) over the
   * "Other" string so a customer can rename the label (e.g. "Others",
   * "Custom Reason") without breaking the free-text behavior. Falls
   * back to the literal "Other" string match for backward compatibility
   * with backends/rows that don't send `custom`.
   * @param {string} label - the alert text (e.g. from btn.dataset.alert)
   * @param {boolean} [custom] - optional backend-supplied flag
   */
  const isOtherAlert = (label, custom) => {
    if (custom === true) return true;
    return typeof label === 'string' && label.trim().toLowerCase() === 'other';
  };

  /**
   * True if `url` points at a different origin than the current page.
   * Used to decide whether a request can safely go through apiCall()
   * (same-origin — no CORS involved) or must instead avoid triggering
   * a CORS preflight (cross-origin — see simpleFetch() below).
   */
  const isCrossOrigin = (url) => {
    try {
      const target = new URL(url, window.location.href);
      return target.origin !== window.location.origin;
    } catch {
      return false;
    }
  };

  /**
   * Cross-origin fallback request.
   *
   * Node-RED's built-in "http in" node has no OPTIONS method support,
   * so it can never answer a CORS preflight request. Rather than
   * requiring one, this deliberately keeps every request within the
   * browser's "simple request" rules so a preflight is never sent:
   *   - No credentials, no custom headers (e.g. no X-Requested-With).
   *   - POST bodies are sent as Content-Type: text/plain (a
   *     CORS-safelisted value) instead of application/json.
   *     The backend's Node-RED "json" node (action: obj) still parses
   *     this string into an object automatically — no flow changes
   *     needed on the Node-RED side for this to keep working.
   *
   * The target Node-RED flow still needs Access-Control-Allow-Origin
   * (and matching method) on its actual GET/POST/error responses —
   * simple requests skip the preflight but the browser still checks
   * that header on the real response.
   */
  const simpleFetch = async (url, options = {}) => {
    const fetchOptions = { method: options.method || 'GET' };
    if (options.signal) fetchOptions.signal = options.signal;

    if (options.body !== undefined) {
      fetchOptions.headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
      fetchOptions.body = typeof options.body === 'object'
        ? JSON.stringify(options.body)
        : options.body;
    }

    const res = await fetch(url, fetchOptions);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Response from "${url}" was not valid JSON.`);
    }

    if (!res.ok) {
      const err = new Error(data?.message || `Request failed with status ${res.status}.`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }

    return data;
  };

  /**
   * Network wrapper.
   * Same-origin  → uses the ERP's own apiCall() (utils.js) so
   *                auth/session handling stays consistent app-wide.
   * Cross-origin → uses simpleFetch() to avoid a CORS preflight that
   *                Node-RED's http-in node cannot answer.
   */
  const request = async (url, options = {}) => {
    if (typeof apiCall === 'function' && !isCrossOrigin(url)) {
      return apiCall(url, options);
    }
    return simpleFetch(url, options);
  };

  /** Toast wrapper — prefers the ERP's own openToast() (utils.js). */
  const notify = (message, type = 'info', duration = 5000) => {
    if (typeof openToast === 'function') {
      openToast(message, type, duration);
      return;
    }
    // Minimal fallback so the library still works without utils.js
    if (type === 'error') {
      console.error(`[SOS] ${message}`);
    } else {
      console.log(`[SOS] ${message}`);
    }
  };

  // ==========================================================
  // DOM CREATION — no popup HTML ever lives on the page itself
  // ==========================================================

  const createModal = () => {
    const overlay = document.createElement('div');
    overlay.className = 'sos-overlay';
    overlay.setAttribute('role', 'presentation');

    overlay.innerHTML = `
      <div class="sos-modal" role="dialog" aria-modal="true" aria-labelledby="sos-title">
        <div class="sos-header">
          <h2 class="sos-title" id="sos-title">Emergency Alert</h2>
          <button type="button" class="sos-close" aria-label="Close">&#10005;</button>
        </div>
        <div class="sos-body">
          <p class="sos-label">
            <span class="sos-label-icon">&#9889;</span>
            Select Alert Reason
          </p>
          <div class="sos-grid" role="group" aria-label="Alert reasons"></div>

          <!-- Free-text reason for the "Other"/custom alert. Hidden by
               default via .sos-other-hidden; only shown when an
               Other/custom button is selected (see showOtherInput()).
               No IDs beyond what ARIA requires — elements are found
               via scoped querySelector(). -->
          <div class="sos-other-wrapper sos-other-hidden">
            <input
              type="text"
              class="sos-other-input"
              placeholder="Mention the reason..."
              maxlength="150"
              aria-label="Custom alert reason"
              aria-describedby="sos-other-counter"
            />
            <!-- NEW — inline red validation error, shown/hidden via
                 showOtherError()/clearOtherError() in sendAlert() and
                 on input. Empty by default. -->
            <div class="sos-other-error" role="alert" aria-live="assertive"></div>
            <div class="sos-other-counter" id="sos-other-counter" aria-live="polite">0 / 150</div>
          </div>
        </div>
        <div class="sos-footer">
          <button type="button" class="sos-send" disabled aria-disabled="true">
            Send Alert
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    els.overlay = overlay;
    els.modal = overlay.querySelector('.sos-modal');
    els.grid = overlay.querySelector('.sos-grid');
    els.sendBtn = overlay.querySelector('.sos-send');
    els.closeBtn = overlay.querySelector('.sos-close');
    els.otherWrapper = overlay.querySelector('.sos-other-wrapper');
    els.otherInput = overlay.querySelector('.sos-other-input');
    els.otherCounter = overlay.querySelector('.sos-other-counter');
    els.otherError = overlay.querySelector('.sos-other-error'); // NEW

    // Bound once here, for the lifetime of this DOM, instead of on
    // every openModal()/closeModal() cycle. Safe because .sos-overlay
    // is `visibility: hidden` (and thus unclickable/unfocusable)
    // whenever it isn't `.sos-open`. Only the document-level keydown
    // listener still binds/unbinds per open/close, since that one is
    // global and must never fire while the modal is closed.
    els.grid.addEventListener('click', onGridClick);
    els.sendBtn.addEventListener('click', onSendClick);
    els.closeBtn.addEventListener('click', onCloseClick);
    els.overlay.addEventListener('click', onOverlayClick);
    els.otherInput.addEventListener('input', onOtherInputChange); // CHANGED — now also clears inline error
    els.otherInput.addEventListener('keydown', onOtherInputKeydown);
  };

  const renderLoading = () => {
    els.grid.innerHTML = `
      <div class="sos-state" style="grid-column: 1 / -1;" role="status" aria-live="polite">
        <div class="sos-spinner" aria-hidden="true"></div>
        <span>Loading alert reasons&hellip;</span>
      </div>
    `;
  };

  const renderError = (message) => {
    els.grid.innerHTML = `
      <div class="sos-state" style="grid-column: 1 / -1;" role="alert">
        <span>${escapeHtml(message || 'Unable to load alert reasons.')}</span>
        <button type="button" class="sos-retry">Retry</button>
      </div>
    `;
    const retryBtn = els.grid.querySelector('.sos-retry'); // scoped, no global ID lookup
    if (retryBtn) {
      retryBtn.addEventListener('click', () => fetchAlerts(true)); // force bypasses the cache
    }
  };

  /**
   * Guarantees a client-side "Other" option always exists, regardless
   * of what the backend's alert list contains. The free-text flow
   * shouldn't depend on someone remembering to seed an "Other" row in
   * the sosalerts table — that would make the feature silently
   * disappear for any customer/table that doesn't have it.
   * No-ops if the API already returned its own "Other" entry (avoids
   * a duplicate button).
   */
  const appendOtherButtonIfMissing = () => {
    const already = Array.from(els.grid.querySelectorAll('.sos-alert'))
      .some((b) => isOtherAlert(b.dataset.alert, b.dataset.custom === 'true'));
    if (already) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sos-alert sos-alert--wide';
    btn.dataset.alert = 'Other';
    btn.textContent = 'Other';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-pressed', 'false');
    els.grid.appendChild(btn);
  };

  const renderEmpty = () => {
    els.grid.innerHTML = `
      <div class="sos-state" style="grid-column: 1 / -1;">
        <span>No alert reasons are available right now.</span>
      </div>
    `;
    appendOtherButtonIfMissing(); // still let the user report something via free text
  };

  const renderAlerts = () => {
    if (!Array.isArray(state.alerts) || state.alerts.length === 0) {
      renderEmpty();
      return;
    }

    els.grid.innerHTML = '';

    state.alerts.forEach((item) => {
      const label = (item && item.alert !== undefined && item.alert !== null)
        ? String(item.alert)
        : '';
      if (!label.trim()) return;

      const isCustom = !!(item && item.custom === true); // explicit backend metadata

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sos-alert';
      btn.dataset.alert = label;
      if (isCustom) btn.dataset.custom = 'true';
      btn.textContent = label;
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-pressed', 'false');

      // Visual nicety only — a lone "Other"/custom-style reason spans
      // the full row width, matching the reference UI. Purely cosmetic;
      // does not affect selection/submit logic.
      if (isCustom || label.trim().toLowerCase() === 'other') {
        btn.classList.add('sos-alert--wide');
      }

      els.grid.appendChild(btn);
    });

    appendOtherButtonIfMissing(); // guarantee "Other" is always present
  };

  // ==========================================================
  // ACTIONS
  // ==========================================================

  /** Reveals the free-text "Other" input and focuses it. */
  const showOtherInput = () => {
    if (!els.otherWrapper) return;
    els.otherWrapper.classList.remove('sos-other-hidden');
    clearOtherError(); // NEW — never show a stale error from a previous selection
    updateOtherCounter();
    setTimeout(() => els.otherInput && els.otherInput.focus(), 50);
  };

  /** Hides the free-text "Other" input and clears its value. */
  const hideOtherInput = () => {
    if (!els.otherWrapper) return;
    els.otherWrapper.classList.add('sos-other-hidden');
    if (els.otherInput) els.otherInput.value = '';
    clearOtherError(); // NEW
    updateOtherCounter();
  };

  /** Refreshes the "N / 150" live counter under the Other input. */
  const updateOtherCounter = () => {
    if (!els.otherCounter || !els.otherInput) return;
    els.otherCounter.textContent = `${els.otherInput.value.length} / 150`;
  };

  /**
   * NEW — shows an inline red error message directly under the Other
   * input (mirrors the CopperCloud .field-error pattern) and marks
   * the wrapper invalid so the input border/focus ring turn red too.
   * @param {string} message
   */
  const showOtherError = (message) => {
    if (!els.otherError || !els.otherWrapper) return;
    els.otherError.textContent = message;
    els.otherError.classList.add('sos-other-error--visible');
    els.otherWrapper.classList.add('sos-other-wrapper--invalid');
  };

  /** NEW — clears the inline error and the invalid state. */
  const clearOtherError = () => {
    if (!els.otherError || !els.otherWrapper) return;
    els.otherError.textContent = '';
    els.otherError.classList.remove('sos-other-error--visible');
    els.otherWrapper.classList.remove('sos-other-wrapper--invalid');
  };

  /**
   * NEW — fires on every keystroke in the Other input. Updates the
   * character counter and clears any visible inline error as soon as
   * the person starts fixing it, so the error doesn't linger stale
   * once they've corrected the value.
   */
  const onOtherInputChange = () => {
    updateOtherCounter();
    if (els.otherError && els.otherError.classList.contains('sos-other-error--visible')) {
      clearOtherError();
    }
  };

  /** Enter submits from the Other input; Tab order is untouched. */
  const onOtherInputKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendAlert();
    }
  };

  /**
   * @param {boolean} [force=false] - bypasses the cache (used by the
   *   Retry button so a manual retry never serves stale data).
   */
  const fetchAlerts = async (force = false) => {
    // Serve from cache when it's still fresh; skips the network call
    // entirely but still re-renders (handles a re-open right after a
    // previous close).
    const isCacheFresh = config.cacheDuration > 0
      && state.alerts.length > 0
      && (Date.now() - state.cacheTimestamp) < config.cacheDuration;

    if (!force && isCacheFresh) {
      log('serving alerts from cache');
      renderAlerts();
      return;
    }

    state.isLoading = true;
    state.selectedAlert = null;
    state.selectedIsCustom = false;
    hideOtherInput(); // fresh fetch means no reason is selected yet
    updateSendButton();
    renderLoading();

    // Abort a still-in-flight request from a previous open before
    // starting a new one / if the modal closes mid-request.
    if (state.abortController) state.abortController.abort();
    state.abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

    const url = config.getAlertsUrl || `${config.apiBase}/sos-alerts`;

    try {
      const data = await request(url, {
        method: 'GET',
        signal: state.abortController ? state.abortController.signal : undefined,
      });

      if (!data || data.success !== true || !Array.isArray(data.alerts)) {
        throw new Error('Unexpected response format from the alerts API.');
      }

      state.alerts = data.alerts;
      state.cacheTimestamp = Date.now();
      renderAlerts();
    } catch (err) {
      // A deliberate abort is not a real failure; the modal is either
      // closing or a newer fetch has already taken over.
      if (err && err.name === 'AbortError') return;

      state.alerts = [];
      state.cacheTimestamp = 0;
      const message = err && err.message ? err.message : 'Failed to load alerts.';
      renderError(message);
      if (typeof config.onError === 'function') config.onError(err);
    } finally {
      state.isLoading = false;
    }
  };

  const selectAlert = (btnEl) => {
    if (!btnEl || state.isSending) return;

    els.grid.querySelectorAll('.sos-alert').forEach((b) => {
      b.classList.remove('sos-selected');
      b.setAttribute('aria-pressed', 'false');
    });

    btnEl.classList.add('sos-selected');
    btnEl.setAttribute('aria-pressed', 'true');
    state.selectedAlert = btnEl.dataset.alert;
    state.selectedIsCustom = btnEl.dataset.custom === 'true';

    // Show the free-text box only for "Other"/custom reasons;
    // otherwise make sure it's hidden and cleared so a predefined
    // alert sends as-is.
    if (isOtherAlert(state.selectedAlert, state.selectedIsCustom)) {
      showOtherInput();
    } else {
      hideOtherInput();
    }

    updateSendButton();
  };

  const updateSendButton = () => {
    const enabled = !!state.selectedAlert && !state.isLoading && !state.isSending;
    els.sendBtn.disabled = !enabled;
    els.sendBtn.setAttribute('aria-disabled', String(!enabled));
  };

  const sendAlert = async () => {
    if (!state.selectedAlert || state.isSending) return;

    // Validate machine before ever hitting the network.
    const machineId = resolveMachineId();
    if (!machineId || !String(machineId).trim()) {
      notify('No machine selected. Please select a machine first.', 'error', 6000);
      return;
    }

    // For "Other"/custom, the payload's alert text is whatever the
    // user typed (trimmed + length-capped as a client-side safety net
    // — maxlength=150 already enforces this in the UI); predefined
    // alerts are untouched and behave exactly as before.
    let alertText = state.selectedAlert;
    if (isOtherAlert(state.selectedAlert, state.selectedIsCustom)) {
      const typed = ((els.otherInput && els.otherInput.value) || '').trim().slice(0, 150);

      // CHANGED — both validation failures now show inline under the
      // input (red text, matching CopperCloud's .field-error look)
      // instead of a toast, so the person sees exactly which field is
      // wrong without it competing with earlier/stacked toasts.
      if (!typed) {
        showOtherError('Please enter the alert reason.');
        els.otherInput && els.otherInput.focus();
        return;
      }

      // Mirrors the backend's minLen: 2 rule (Set Schema - SOS Alert
      // node) so a 1-character reason is caught instantly, client-side,
      // instead of round-tripping to the API just to get rejected.
      if (typed.length < 2) {
        showOtherError('Alert reason must be at least 2 characters.');
        els.otherInput && els.otherInput.focus();
        return;
      }

      clearOtherError(); // NEW — passed validation, make sure nothing stale lingers
      alertText = typed;
    }

    state.isSending = true;
    updateSendButton();

    const originalHtml = els.sendBtn.innerHTML;
    // Lightweight inline spinner instead of plain text, no external libs.
    els.sendBtn.innerHTML = '<span class="sos-send-spinner" aria-hidden="true"></span> Sending\u2026';

    const url = config.postAlertUrl || `${config.apiBase}/sos-alert`;
    const payload = { machineid: machineId, alert: alertText };
    log('sending alert', payload); // silent unless debug: true

    try {
      const data = await request(url, { method: 'POST', body: payload });

      if (!data || data.success !== true) {
        throw new Error((data && data.message) || 'Failed to save the alert.');
      }

      notify(data.message || 'SOS Alert Sent Successfully', 'success', 4000);
      if (typeof config.onSuccess === 'function') config.onSuccess(data);
      closeModal();
    } catch (err) {
      // NEW — if the backend still rejects the alert text (e.g. a
      // future stricter server-side rule), surface that inline under
      // the Other input too, rather than only as a toast, so the
      // error stays visible right next to the field that caused it.
      if (isOtherAlert(state.selectedAlert, state.selectedIsCustom)) {
        showOtherError(err && err.message ? err.message : 'Failed to send alert. Please try again.');
      }
      notify(err && err.message ? err.message : 'Failed to send alert. Please try again.', 'error', 7000);
      if (typeof config.onError === 'function') config.onError(err);
    } finally {
      state.isSending = false;
      els.sendBtn.innerHTML = originalHtml;
      updateSendButton();
    }
  };

  // ==========================================================
  // MODAL OPEN / CLOSE
  // ==========================================================

  const openModal = () => {
    if (!els.overlay) createModal();

    lastFocusedEl = document.activeElement;

    els.overlay.classList.add('sos-open');
    document.body.style.overflow = 'hidden';

    bindModalEvents();
    fetchAlerts();

    // Move focus into the modal for accessibility
    setTimeout(() => {
      els.closeBtn && els.closeBtn.focus();
    }, 50);
  };

  const closeModal = () => {
    if (!els.overlay) return;

    els.overlay.classList.remove('sos-open');
    document.body.style.overflow = '';

    unbindModalEvents();

    if (state.abortController) state.abortController.abort();

    state.selectedAlert = null;
    state.selectedIsCustom = false;
    state.alerts = [];
    hideOtherInput(); // clear/hide the free-text box (and its error) on close

    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      lastFocusedEl.focus();
    }
  };

  // ==========================================================
  // EVENT BINDING
  // ==========================================================

  const onGridClick = (e) => {
    const btn = e.target.closest('.sos-alert');
    if (btn) selectAlert(btn);
  };

  const onSendClick = () => sendAlert();

  const onCloseClick = () => closeModal();

  const onOverlayClick = (e) => {
    if (e.target === els.overlay) closeModal();
  };

  const onKeydown = (e) => {
    if (!els.overlay || !els.overlay.classList.contains('sos-open')) return;

    if (e.key === 'Escape') {
      closeModal();
      return;
    }

    // Basic focus trap
    if (e.key === 'Tab') {
      // 'input:not([disabled])' included so the "Other" text box
      // participates in the Tab/Shift+Tab loop like every other control.
      const focusable = els.modal.querySelectorAll(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])'
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // Only the document-level listener still binds/unbinds per
  // open/close; it's the one listener that truly must not fire while
  // the modal is closed.
  const bindModalEvents = () => {
    document.addEventListener('keydown', onKeydown);
  };

  const unbindModalEvents = () => {
    document.removeEventListener('keydown', onKeydown);
  };

  const bindTrigger = () => {
    if (!els.triggerBtn) return;
    els.triggerBtn.addEventListener('click', openModal);
  };

  const unbindTrigger = () => {
    if (!els.triggerBtn) return;
    els.triggerBtn.removeEventListener('click', openModal);
  };

  // ==========================================================
  // PUBLIC API
  // ==========================================================

  /**
   * Initialises the SOS widget.
   * @param {Object} options
   * @param {string|HTMLElement} options.button - Selector or element for the trigger button.
   * @param {string|Function} [options.machineId=''] - Static id or a function returning the current id.
   * @param {string} [options.apiBase='/app'] - Base path for the SOS endpoints.
   * @param {string} [options.getAlertsUrl] - Full override for the GET alerts URL.
   * @param {string} [options.postAlertUrl] - Full override for the POST alert URL.
   * @param {number} [options.cacheDuration=300000] - ms to reuse a cached alerts list (0 disables caching).
   * @param {boolean} [options.debug=false] - logs internal diagnostics to the console when true.
   * @param {Function} [options.onSuccess] - (data) => {} called after a successful POST /sos-alert.
   * @param {Function} [options.onError] - (err) => {} called after a failed GET or POST.
   */
  const init = (options = {}) => {
    if (state.initialized) {
      console.warn('SOS.init: already initialized. Call SOS.destroy() first to re-initialize.');
      return;
    }

    if (!options.button) {
      throw new Error('SOS.init: "button" option is required (selector or element).');
    }

    config = { ...config, ...options };

    els.triggerBtn = typeof config.button === 'string'
      ? document.querySelector(config.button)
      : config.button;

    if (!els.triggerBtn) {
      throw new Error(`SOS.init: no element found for button "${config.button}".`);
    }

    bindTrigger();
    state.initialized = true;
  };

  /** Fully tears down the widget — removes DOM, listeners, and resets state. */
  const destroy = () => {
    unbindTrigger();

    if (state.abortController) state.abortController.abort();

    if (els.overlay) {
      unbindModalEvents();
      els.overlay.remove();
    }

    document.body.style.overflow = '';

    els = {
      triggerBtn: null, overlay: null, modal: null, grid: null, sendBtn: null, closeBtn: null,
      otherWrapper: null, otherInput: null, otherCounter: null, otherError: null,
    };
    state = {
      alerts: [], selectedAlert: null, selectedIsCustom: false, isLoading: false,
      isSending: false, initialized: false, cacheTimestamp: 0, abortController: null,
    };
    config = {
      button: null, machineId: '', apiBase: '/app', getAlertsUrl: null, postAlertUrl: null,
      cacheDuration: 300000, debug: false, onSuccess: null, onError: null,
    };
  };

  return {
    init,
    destroy,
    open: openModal,
    close: closeModal,
  };
})();

// Prevent accidental reassignment / pollution of the global.
if (typeof window !== 'undefined') {
  window.SOS = SOS;
}
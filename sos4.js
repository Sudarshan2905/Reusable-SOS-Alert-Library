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
       SOS.init({ button: '#btnSOS' });
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
    apiBase: '/app',       // base path — GET {apiBase}/sos-alerts, POST {apiBase}/sos-alert
    context: {},
    getAlertsUrl: null,    // full override for the GET url
    postAlertUrl: null,    // full override for the POST url
    cacheDuration: 300000, // ms to reuse a cached GET /sos-alerts response (default 5 min; 0 disables caching)
    debug: false,          // when true, prints internal diagnostics via log()
    onSuccess: null,       // optional (data) => {} called after a successful POST /sos-alert
    onError: null,         // optional (err) => {} called after a failed GET or POST
  };
// REMOVE: categorySelect, gridHint
// ADD: categoryGrid, alertSection
  let els = {
    triggerBtn: null,
    overlay: null,
    modal: null,
    categoryGrid: null,     // NEW — replaces categorySelect
    alertSection: null,     // NEW — hideable <section> wrapping "SELECT ALERT"
    grid: null,             // UNCHANGED reference, now lives inside .sos-alert-section
    sendBtn: null,
    closeBtn: null,
    otherWrapper: null,
    otherInput: null,
    otherCounter: null,
    otherError: null,
  };

  let state = {
    alerts: [],
    categories: [],                 // NEW
    selectedCategory: '',           // NEW
    isLoadingCategories: false,     // NEW
    categoriesCacheTimestamp: 0,    // NEW — separate from alert cache
    alertsCache: {},                // NEW — { [category]: { data, timestamp } } so Safety never serves Maintenance
    selectedRecId: null,
    selectedAlert: null,
    selectedIsCustom: false, // companion flag for isOtherAlert()
    isLoading: false,
    isSending: false,
    initialized: false,
  
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
          Select Alert Category
        </p>

        <!-- NEW — category buttons, replaces <select> entirely -->
        <div class="sos-category-grid" role="group" aria-label="Select alert category"></div>

        <!-- NEW — whole alert section hidden until a category is picked -->
        <section class="sos-alert-section" hidden>
          <p class="sos-label sos-alert-section-label">
            <span class="sos-label-icon">&#9889;</span>
            Select Alert
          </p>

          <div class="sos-grid" role="group" aria-label="Alert reasons"></div>

          <div class="sos-other-wrapper sos-other-hidden">
            <input
              type="text"
              class="sos-other-input"
              placeholder="Mention the reason..."
              maxlength="150"
              aria-label="Custom alert reason"
              aria-describedby="sos-other-counter"
            />
            <div class="sos-other-error" role="alert" aria-live="assertive"></div>
            <div class="sos-other-counter" id="sos-other-counter" aria-live="polite">0 / 150</div>
          </div>
        </section>
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
  els.categoryGrid = overlay.querySelector('.sos-category-grid'); // NEW
  els.alertSection = overlay.querySelector('.sos-alert-section'); // NEW
  els.grid = overlay.querySelector('.sos-grid');                  // now inside .sos-alert-section
  els.sendBtn = overlay.querySelector('.sos-send');
  els.closeBtn = overlay.querySelector('.sos-close');
  els.otherWrapper = overlay.querySelector('.sos-other-wrapper');
  els.otherInput = overlay.querySelector('.sos-other-input');
  els.otherCounter = overlay.querySelector('.sos-other-counter');
  els.otherError = overlay.querySelector('.sos-other-error');

  els.categoryGrid.addEventListener('click', onCategoryGridClick); // NEW — event delegation
  els.grid.addEventListener('click', onGridClick);
  els.sendBtn.addEventListener('click', onSendClick);
  els.closeBtn.addEventListener('click', onCloseClick);
  els.overlay.addEventListener('click', onOverlayClick);
  els.otherInput.addEventListener('input', onOtherInputChange);
  els.otherInput.addEventListener('keydown', onOtherInputKeydown);
};


// ── NEW — click delegation on the category grid ──
const onCategoryGridClick = (e) => {
  const btn = e.target.closest('.sos-category-btn');
  if (btn) onCategorySelect(btn.dataset.category);
};

// ── MODIFIED — renders category BUTTONS (was <option> population).
//    textContent + createElement only — categories are untrusted
//    backend data and must never go through innerHTML. ──
const renderCategories = () => {
  if (!els.categoryGrid) return;
  els.categoryGrid.innerHTML = '';

  if (!Array.isArray(state.categories) || state.categories.length === 0) {
    els.categoryGrid.innerHTML = `
      <div class="sos-state" style="grid-column: 1 / -1;">
        <span>No categories are available right now.</span>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment(); // NEW — batch append, single reflow

  state.categories.forEach((item) => {
    const label = (item && item.category !== undefined && item.category !== null)
      ? String(item.category)
      : '';
    if (!label.trim()) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sos-category-btn';
    btn.dataset.category = label;
    btn.textContent = label; // textContent — no injection risk
    btn.setAttribute('aria-pressed', 'false');
    fragment.appendChild(btn);
  });

  els.categoryGrid.appendChild(fragment);
};

// ── NEW — loading/error states for the category grid itself
//    (this is the only visible content before a category is picked) ──
const renderCategoryLoading = () => {
  els.categoryGrid.innerHTML = `
    <div class="sos-state" style="grid-column: 1 / -1;" role="status" aria-live="polite">
      <div class="sos-spinner" aria-hidden="true"></div>
      <span>Loading categories&hellip;</span>
    </div>
  `;
};

// ── MODIFIED — was showGridHint('') + wrote into els.grid;
//    now writes into els.categoryGrid, since alerts aren't shown yet. ──
const renderCategoryError = (message) => {
  els.categoryGrid.innerHTML = `
    <div class="sos-state" style="grid-column: 1 / -1;" role="alert">
      <span>${escapeHtml(message || 'Unable to load categories.')}</span>
      <button type="button" class="sos-retry">Retry</button>
    </div>
  `;
  const retryBtn = els.categoryGrid.querySelector('.sos-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => fetchCategories(true));
};

// ── NEW — toggles selected visual/aria state on category buttons ──
const updateCategorySelectionUI = () => {
  els.categoryGrid.querySelectorAll('.sos-category-btn').forEach((btn) => {
    const isSelected = btn.dataset.category === state.selectedCategory;
    btn.classList.toggle('is-selected', isSelected);
    btn.setAttribute('aria-pressed', String(isSelected));
  });
};

// ── REPLACES onCategoryChange(e). Takes the category value directly
//    (the click-delegation handler above pulls it from dataset). ──
const onCategorySelect = (category) => {
  if (!category || state.isSending) return;

  state.selectedCategory = category;

  // Reset alert selection on every category change — same as before
  state.selectedAlert = null;
  state.selectedRecId = null;
  state.selectedIsCustom = false;
  hideOtherInput();

  updateCategorySelectionUI();

  els.grid.innerHTML = '';
  els.alertSection.hidden = false; // NEW — reveal Step 2

  updateSendButton();

  fetchAlertsForCategory(category); // EXISTING function, called exactly as before
};


  



    // ── NEW — GET /sos-alerts (no category) ──
const fetchCategories = async (force = false) => {
  const isCacheFresh = config.cacheDuration > 0
    && state.categories.length > 0
    && (Date.now() - state.categoriesCacheTimestamp) < config.cacheDuration;

  if (!force && isCacheFresh) {
    log('serving categories from cache');
    renderCategories(); // same call, new implementation
    return;
  }

  state.isLoadingCategories = true;
  renderCategoryLoading(); // MODIFIED — was showGridHint('Loading categories…')

  if (state.abortController) state.abortController.abort();
  state.abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

  const url = config.getAlertsUrl || `${config.apiBase}/sos-alerts`;

  try {
    const data = await request(url, {
      method: 'GET',
      signal: state.abortController ? state.abortController.signal : undefined,
    });

    if (!data || data.success !== true || !Array.isArray(data.categories)) {
      throw new Error('Unexpected response format from the categories API.');
    }

    state.categories = data.categories;
    state.categoriesCacheTimestamp = Date.now();
    renderCategories(); // MODIFIED — removed the showGridHint(...) call after it
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    state.categories = [];
    state.categoriesCacheTimestamp = 0;
    renderCategoryError(err && err.message ? err.message : 'Failed to load categories.'); // MODIFIED
    if (typeof config.onError === 'function') config.onError(err);
  } finally {
    state.isLoadingCategories = false;
  }
};

    // ── MODIFIED — fetchAlerts() renamed/retargeted: now always
  //    scoped to a category, keyed cache instead of one shared cache. ──

const fetchAlertsForCategory = async (category, force = false) => {
  const cached = state.alertsCache[category];
  const isCacheFresh = config.cacheDuration > 0
    && cached
    && (Date.now() - cached.timestamp) < config.cacheDuration;

  if (!force && isCacheFresh) {
    log('serving alerts from cache for category', category);
    state.alerts = cached.data;
    renderAlerts(); // MODIFIED — removed hideGridHint()
    return;
  }

  state.isLoading = true;
  renderLoading(); // MODIFIED — removed hideGridHint()
  updateSendButton();

  if (state.abortController) state.abortController.abort();
  state.abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

  const base = config.getAlertsUrl || `${config.apiBase}/sos-alerts`;
  const url = `${base}?category=${encodeURIComponent(category)}`; // UNCHANGED — still encoded

  try {
    const data = await request(url, {
      method: 'GET',
      signal: state.abortController ? state.abortController.signal : undefined,
    });

    if (!data || data.success !== true || !Array.isArray(data.alerts)) {
      throw new Error('Unexpected response format from the alerts API.');
    }

    // NEW — stale-response guard: if the user switched categories
    // while this request was in flight, a slower earlier response
    // must not overwrite the currently-selected category's alerts.
    if (state.selectedCategory !== category) {
      log('discarding stale alerts response for', category, '— current is', state.selectedCategory);
      return;
    }

    state.alerts = data.alerts;
    state.alertsCache[category] = { data: data.alerts, timestamp: Date.now() };
    renderAlerts();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (state.selectedCategory !== category) return; // NEW — same guard on failure path
    state.alerts = [];
    delete state.alertsCache[category];
    const message = err && err.message ? err.message : 'Failed to load alerts.';
    renderError(message);
    if (typeof config.onError === 'function') config.onError(err);
  } finally {
    state.isLoading = false;
    updateSendButton();
  }
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
      retryBtn.addEventListener('click', () => {
  if (state.selectedCategory) {
      fetchAlertsForCategory(state.selectedCategory, true);
        }
      });
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
      btn.dataset.recid = item.recid;
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




  const selectAlert = (btnEl) => {
    if (!btnEl || state.isSending) return;

    els.grid.querySelectorAll('.sos-alert').forEach((b) => {
      b.classList.remove('sos-selected');
      b.setAttribute('aria-pressed', 'false');
    });

    btnEl.classList.add('sos-selected');
    btnEl.setAttribute('aria-pressed', 'true');
    state.selectedAlert = btnEl.dataset.alert;
    state.selectedRecId = btnEl.dataset.recid || null;
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
    const enabled = !!state.selectedCategory && !!state.selectedAlert && !state.isLoading && !state.isSending;
    els.sendBtn.disabled = !enabled;
    els.sendBtn.setAttribute('aria-disabled', String(!enabled));
  };



  const sendAlert = async () => {
    if (!state.selectedAlert || state.isSending) return;



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
    const other_attributes= config.context || {};
    // ── sendAlert() — MODIFIED: payload now includes category ──
    const payload = {
        sos_recid: state.selectedRecId,
        category: state.selectedCategory,
        alert: alertText,
        other_attributes: other_attributes
    };
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

    // Reset per-open UI state
    state.selectedCategory = '';
    state.alerts = [];
    els.grid.innerHTML = '';
    els.alertSection.hidden = true; // MODIFIED — was: els.categorySelect.value = ''; showGridHint(...)

    fetchCategories();

    setTimeout(() => {
      els.closeBtn && els.closeBtn.focus();
    }, 50);
  };

  // ── closeModal() — MODIFIED: also reset category state ──
const closeModal = () => {
  if (!els.overlay) return;

  els.overlay.classList.remove('sos-open');
  document.body.style.overflow = '';

  unbindModalEvents();

  if (state.abortController) state.abortController.abort();

  state.selectedAlert = null;
  state.selectedRecId = null;
  state.selectedIsCustom = false;
  state.selectedCategory = '';
  state.alerts = [];
  hideOtherInput();
  if (els.alertSection) els.alertSection.hidden = true; // NEW — keeps re-open state clean

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
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          // REMOVED: 'select:not([disabled]), ' — no <select> left in the modal
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
   * @param {string} [options.apiBase='/app'] - Base path for the SOS endpoints.
   * @param {Object} [options.context={}] - Additional page context sent separately as other_attributes.
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
  // ── destroy() — MODIFIED: reset new fields too ──
  els = {
    triggerBtn: null, overlay: null, modal: null, categoryGrid: null, alertSection: null,
    grid: null, sendBtn: null, closeBtn: null,
    otherWrapper: null, otherInput: null, otherCounter: null, otherError: null,
  };
  state = {
    alerts: [], categories: [], selectedCategory: '', isLoadingCategories: false,
    categoriesCacheTimestamp: 0, alertsCache: {},
    selectedAlert: null, selectedRecId: null, selectedIsCustom: false, isLoading: false,
    isSending: false, initialized: false, abortController: null,
  };
    config = {
      button: null, apiBase: '/app', context: {}, getAlertsUrl: null, postAlertUrl: null,
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
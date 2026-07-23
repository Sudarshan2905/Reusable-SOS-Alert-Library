# SOS Emergency Alert Library

A small, reusable, drop-in widget that lets any ERP page report an emergency
alert against a machine/work-order. One button, one modal, zero page-level
HTML — everything is built and controlled by `sos.js`.

```
Trigger button  →  Modal opens  →  Pick a reason (or "Other" + free text)  →  Send
                        ↓                              ↓
                GET /sos-alerts                  POST /sos-alert
```

---

## 1. What's in this package

| File | Purpose |
|---|---|
| `sos.js` | The library itself. Exposes exactly one global: `window.SOS`. |
| `sos.css` | All styling, namespaced under `.sos-*`. Token-driven (see [Theming](#5-theming)). |
| `sos-flow.json` | Node-RED flow implementing the two backend endpoints (`GET /sos-alerts`, `POST /sos-alert`) against MySQL. |
| `sos-demo.html` | Minimal working example — copy the wiring from here. |

Nothing else is required. No build step, no bundler, no dependencies of its
own (it *optionally* reuses your ERP's `apiCall()` / `openToast()` from
`utils.js` if that's already on the page — see [Integration with the ERP shell](#4-integration-with-the-erp-shell)).

               User
                 │
                 ▼
        SOS Button (HTML)
                 │
                 ▼
             sos.js
                 │
        ┌────────┴────────┐
        ▼                 ▼
 GET /sos-alerts    POST /sos-alert
        │                 │
        ▼                 ▼
      Node-RED REST API
                 │
                 ▼
             MySQL Database
        ┌────────┴─────────┐
        ▼                  ▼
    sosalerts      sosalert_history

---

## 2. Quick start

### 2.1 Add the files to your page

```html

<head>
    <link rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/Sudarshan2905/Reusable-SOS-Alert-Library@main/sos.css">
</head>

<body style="padding:40px;font-family:Arial">

    <h2>SOS Library Test</h2>

    <button id="btnSOS" class="sos-trigger">
        SOS
    </button>

    <script src="https://cdn.jsdelivr.net/gh/Sudarshan2905/Reusable-SOS-Alert-Library@main/sos.js">

    </script>
```

### 2.2 Initialize it

```html
<script>
  document.addEventListener('DOMContentLoaded', () => {
    SOS.init({
      button: '#btnSOS',
      machineId: () => document.getElementById('demo-machine-select').value,
      apiBase: 'http://127.0.0.1:1880', // or '/app' in production behind the same origin
    });
  });
</script>
```

Clicking `#btnSOS` now opens the Emergency Alert modal, fetches the list of
reasons from your backend, and lets the user send one. That's the entire
integration — see `sos-demo.html` for a complete, runnable page.

---

## 3. Public API

Everything below is called on the single global `SOS` object.

### `SOS.init(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `button` | `string \| HTMLElement` | **required** | Selector or element for the trigger button. |
| `machineId` | `string \| () => string` | `''` | Static machine/work-order id, or a function that returns the *current* one at click time (recommended — see demo). |
| `apiBase` | `string` | `'/app'` | Base path; the library calls `GET {apiBase}/sos-alerts` and `POST {apiBase}/sos-alert`. |
| `getAlertsUrl` | `string` | — | Full override for the GET url (ignores `apiBase`). |
| `postAlertUrl` | `string` | — | Full override for the POST url (ignores `apiBase`). |
| `cacheDuration` | `number` (ms) | `300000` (5 min) | How long a fetched alert list is reused without hitting the network again. `0` disables caching. |
| `debug` | `boolean` | `false` | When `true`, prints internal diagnostics (`[SOS] ...`) to the console. |
| `onSuccess` | `(data) => void` | — | Called after a successful `POST /sos-alert`, with the parsed response. |
| `onError` | `(err) => void` | — | Called after a failed GET or POST, with the `Error`. |

```js
SOS.init({
  button: '#btnSOS',
  machineId: () => machineSelect.value,
  apiBase: '/app',
  cacheDuration: 60000,
  debug: true,
  onSuccess: (data) => console.log('Alert saved', data),
  onError: (err) => console.error('SOS failed', err),
});
```

### `SOS.open()` / `SOS.close()`
Programmatically open or close the modal (e.g. from your own keyboard
shortcut or menu item).

### `SOS.destroy()`
Fully tears the widget down: removes the modal DOM, un-binds every
listener, aborts any in-flight request, and resets internal state so you
can call `SOS.init()` again (e.g. after a SPA route change).

---

## 4. Integration with the ERP shell

The library **prefers** but does not **require** your existing ERP
utilities:

- If `apiCall()` (from `utils.js`) exists on the page, same-origin requests
  go through it, so your app's session/auth handling is respected automatically.
- If `openToast()` (from `utils.js`) exists, all success/error messages use
  your app's own toast UI. Otherwise the library falls back to
  `console.log`/`console.error`.
- Cross-origin requests (e.g. hitting a Node-RED instance on a different
  host/port during local development, as in `sos-demo.html`) automatically
  bypass `apiCall()` and use a CORS-preflight-safe `fetch()` instead, since
  Node-RED's `http in` node can't answer an `OPTIONS` preflight.

You don't need to configure any of this — it's detected automatically at
call time.

---

## 5. Theming

Every color, radius, shadow, border, and transition in `sos.css` is a CSS
variable declared once in `:root`, and each one falls back to your ERP's
own `brand.css` token (e.g. `--sos-shadow: var(--modal-shadow, ...)`), with
a hard-coded fallback if `brand.css` isn't loaded at all.

**To re-theme the widget, edit only the `:root` block at the top of
`sos.css`.** No other rule needs to change. The emergency red palette
(`--sos-red`, `--sos-red-dark`, `--sos-red-darker`) is intentionally
separate from your brand's `--accent-primary` — emergency UI should stay
visually distinct regardless of brand color.

---

## 6. The "Other" free-text reason

If the alert list contains (or the widget synthesizes — see below) a
button labeled **"Other"**, selecting it reveals a text input instead of
sending the literal word "Other":

- Input is capped at **150 characters**, with a live `N / 150` counter.
- `Enter` inside the box submits, just like clicking **Send Alert**.
- Leaving it empty (or whitespace-only) blocks submission with a toast —
  no request is sent.
- The **"Other"** button is always available even if your `sosalerts`
  table doesn't have a row for it — the library adds it client-side so the
  free-text path never silently disappears for a customer/table that
  forgot to seed it.
- A backend can also mark any reason as free-text explicitly instead of
  relying on the label text, by returning:
  ```json
  { "alert": "Others", "custom": true }
  ```

---

## 7. Backend contract

The widget expects exactly two JSON endpoints (implemented in
`sos-flow.json` via Node-RED + MySQL — import that file into Node-RED and
point the `MySQLdatabase` config node at your own database):

### `GET {apiBase}/sos-alerts`
Returns the distinct, non-empty list of alert reasons.

```json
{ "success": true, "alerts": [ { "alert": "OIL STAIN" }, { "alert": "URGENT STOP" } ] }
```

### `POST {apiBase}/sos-alert`
Saves one alert. Request body:

```json
{ "machineid": "ST1", "alert": "OIL STAIN" }
```
```json
{ "machineid": "ST1", "alert": "Needle broken" }   // when "Other" was used
```

Response:

```json
{ "success": true, "message": "SOS Alert Saved Successfully" }
```

On error, the flow returns `{ "success": false, "message": "..." }` with a
`400` (validation, e.g. missing `alert`) or `500` (database error) status —
the request never hangs.

### Minimal schema

```sql
CREATE TABLE sosalerts (
  alert VARCHAR(255)
);

CREATE TABLE sosalert_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  machineid VARCHAR(100),
  alert VARCHAR(255),
  tscreated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 8. Accessibility

- Full keyboard support: `Tab`/`Shift+Tab` cycles through the modal only
  (focus trap), `Escape` closes it, `Enter` in the Other box submits.
- `role="dialog"` + `aria-modal` + `aria-labelledby` on the modal;
  `role="status"`/`role="alert"` + `aria-live` on loading/error states.
- Focus returns to the element that opened the modal on close.
- Respects `prefers-reduced-motion`.

---

## 9. Browser support

Any evergreen browser (Chrome, Edge, Safari, Firefox). Uses `fetch`,
`AbortController`, CSS custom properties, and `backdrop-filter` (the blur
degrades gracefully — the overlay still darkens correctly without it).

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Other" doesn't show the text box | Hard-refresh — you're on a cached `sos.js`. |
| Toasts don't appear | `#toast-container` missing from the page, or `utils.js` not loaded before `sos.js`. |
| Requests fail silently in local dev | Check `apiBase` — cross-origin requests need CORS headers on the Node-RED responses even though the preflight itself is avoided. |
| Alert list looks stale after adding a new reason in the DB | That's `cacheDuration` (default 5 min) — lower it via `SOS.init({ cacheDuration: 0 })` during development, or wait it out / use Retry. |

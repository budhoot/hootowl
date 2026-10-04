// HootOwl operator dashboard. Plain JavaScript, no build step.
// Every piece of data from the API is inserted with textContent (never innerHTML).

const KEY_STORAGE = 'hootowl.adminKey';
const FILTER_STORAGE = 'hootowl.clientFilter';
const REFRESH_MS = 30_000;
const PAGE_SIZE = 25;

const $ = (selector) => document.querySelector(selector);

const state = {
  key: null,
  clients: [],
  clientFilter: '',
  refreshTimer: null,
};

// ---------------------------------------------------------------- storage

function storageGet(name) {
  try {
    return sessionStorage.getItem(name) ?? localStorage.getItem(name);
  } catch {
    return null;
  }
}

function storageSet(name, value, { remember = false } = {}) {
  try {
    (remember ? localStorage : sessionStorage).setItem(name, value);
  } catch {
    // Private browsing may block storage; the dashboard still works for this tab.
  }
}

function storageClear(name) {
  try {
    sessionStorage.removeItem(name);
    localStorage.removeItem(name);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${state.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the HootOwl API. Is `npm start` running?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOut('Your admin key was not accepted. Please sign in again.');
    throw new ApiError(401, 'Signed out');
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- DOM helpers

// h('div', { class: 'card' }, 'text', childNode) -> element. Strings become text nodes.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else if (name === 'class') el.className = value;
    else if (value === true) el.setAttribute(name, '');
    else el.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Like el.replaceChildren(), but unpacks lists and skips null/false (e.g. an optional banner).
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function toast(message, { error = false } = {}) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', error);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3000);
}

// Runs an async action from a button, disabling it meanwhile and reporting errors.
async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------- formatting

function formatPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || 'Unknown');
}

// Accepts "(555) 123-4567", "555-123-4567", "+44 20 7946 0958" ... and returns E.164.
// 10-digit numbers are assumed to be US/Canada.
function toE164(input) {
  const raw = String(input ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function fullTime(iso) {
  return new Date(iso).toLocaleString();
}

const RECOVERY_LABELS = {
  pending: ['Queued', 'info'],
  sending: ['Sending', 'info'],
  sent: ['Text sent', 'ok'],
  skipped: ['Not texted', 'neutral'],
  failed: ['Text failed', 'bad'],
  needs_review: ['Check needed', 'warn'],
};

const DELIVERY_LABELS = {
  delivered: ['Delivered', 'ok'],
  read: ['Read', 'ok'],
  undelivered: ['Not delivered', 'bad'],
  failed: ['Not delivered', 'bad'],
};

const SKIP_REASONS = {
  client_inactive: 'Not texted: this client is paused.',
  recovery_disabled: 'Not texted: recovery texts are turned off for this client.',
  opted_out: 'Not texted: this caller replied STOP earlier.',
  cooldown: 'Not texted: this caller already got a text in the last 24 hours.',
  caller_number_unavailable: 'Not texted: the caller hid their number.',
};

const DIAL_LABELS = {
  busy: 'line busy',
  'no-answer': 'no answer',
  failed: 'call failed',
};

function badge(label, tone) {
  return h('span', { class: `badge badge-${tone}` }, label);
}

function recoveryBadge(status) {
  const [label, tone] = RECOVERY_LABELS[status] ?? ['No text', 'neutral'];
  return badge(label, tone);
}

function clientName(id) {
  return state.clients.find((c) => c.id === id)?.name ?? `Client #${id}`;
}

function filterQuery(extra = {}) {
  const params = new URLSearchParams(extra);
  if (state.clientFilter) params.set('client_id', state.clientFilter);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------- sign in / out

function showSignIn(message) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  const error = $('#signin-error');
  error.textContent = message ?? '';
  error.hidden = !message;
  $('#signin-key').focus();
}

function signOut(message) {
  state.key = null;
  clearInterval(state.refreshTimer);
  storageClear(KEY_STORAGE);
  $('#signin-key').value = '';
  showSignIn(message);
}

async function signIn(key, { remember = false } = {}) {
  state.key = key;
  const res = await fetch('/admin/clients', { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
  if (!res) {
    state.key = null;
    return 'Cannot reach the HootOwl API. Is `npm start` running?';
  }
  if (res.status === 401) {
    state.key = null;
    return 'That admin key is not correct. Copy ADMIN_API_KEY from your .env file.';
  }
  if (!res.ok) {
    state.key = null;
    return `The API answered with an error (${res.status}).`;
  }
  state.clients = (await res.json()).clients;
  storageSet(KEY_STORAGE, key, { remember });
  $('#signin').hidden = true;
  $('#app').hidden = false;
  renderClientFilter();
  route();
  return null;
}

$('#signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const error = await signIn($('#signin-key').value.trim(), { remember: $('#signin-remember').checked });
  button.disabled = false;
  if (error) showSignIn(error);
});

$('#signout').addEventListener('click', () => signOut());

// ---------------------------------------------------------------- client filter

function renderClientFilter() {
  const select = $('#client-filter');
  const ids = new Set(state.clients.map((c) => String(c.id)));
  if (state.clientFilter && !ids.has(state.clientFilter)) state.clientFilter = '';
  select.replaceChildren(
    h('option', { value: '' }, 'All clients'),
    ...state.clients.map((c) => h('option', { value: c.id }, c.name)),
  );
  select.value = state.clientFilter;
}

$('#client-filter').addEventListener('change', (event) => {
  state.clientFilter = event.target.value;
  storageSet(FILTER_STORAGE, state.clientFilter, { remember: true });
  route();
});

async function reloadClients() {
  state.clients = (await api('GET', '/clients')).clients;
  renderClientFilter();
}

// ---------------------------------------------------------------- routing

const views = {
  overview: renderOverview,
  inbox: renderInbox,
  clients: renderClients,
  client: renderClientDetail,
  review: renderReview,
};

function route() {
  const [name, param] = location.hash.replace(/^#/, '').split('/');
  const view = views[name] ? name : 'overview';
  const tab = view === 'client' ? 'clients' : view;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  clearInterval(state.refreshTimer);
  const main = $('#view');
  fill(main, h('p', { class: 'loading' }, 'Loading…'));
  views[view](main, param).catch((err) => {
    if (err.status === 401) return;
    fill(main, h('div', { class: 'error-box' }, err.message));
  });
  refreshReviewCount();
}

window.addEventListener('hashchange', () => {
  if (state.key) route();
});

// Re-runs a render function every 30 s while the page is visible.
function autoRefresh(fn) {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') fn().catch(() => {});
  }, REFRESH_MS);
}

async function refreshReviewCount() {
  try {
    const { stats, worker } = await api('GET', '/stats');
    const pill = $('#review-count');
    pill.textContent = stats.needs_attention;
    pill.hidden = stats.needs_attention === 0;
    showWorkerStatus(worker);
  } catch {
    // shown on the next successful load
  }
}

function showWorkerStatus(worker) {
  const el = $('#worker-status');
  el.textContent = worker.online ? 'Texting on' : 'Texting offline';
  el.title = worker.online
    ? 'The recovery worker is running and will text missed callers.'
    : 'The recovery worker is not running. Missed calls wait in the queue until it starts.';
  el.classList.toggle('offline', !worker.online);
  el.hidden = false;
}

function workerBanner(worker) {
  if (worker.online) return null;
  return h('div', { class: 'banner', role: 'status' },
    'The recovery worker is offline, so no texts are going out. Missed calls are saved and will be texted ',
    'as soon as it starts: use the HootOwl desktop shortcut, or run "npm run worker".');
}

function pageHead(title, ...actions) {
  return h('div', { class: 'page-head' }, h('h1', {}, title), h('span', { class: 'spacer' }), ...actions);
}

// ---------------------------------------------------------------- overview

async function renderOverview(main) {
  const load = async () => {
    const [{ stats, worker }, { leads }] = await Promise.all([
      api('GET', `/stats${filterQuery()}`),
      api('GET', `/inbox${filterQuery({ limit: 5 })}`),
    ]);

    const tile = (value, label, { href, alert = false } = {}) => h(
      href ? 'a' : 'div',
      { class: `card stat${alert && value > 0 ? ' stat-alert' : ''}`, href },
      h('div', { class: 'stat-value' }, value),
      h('div', { class: 'stat-label' }, label),
    );

    const answerRate = stats.calls_7d > 0
      ? `${Math.round(((stats.calls_7d - stats.missed_calls_7d) / stats.calls_7d) * 100)}%`
      : '–';

    fill(main,
      pageHead('Overview', h('span', { class: 'muted small' }, 'Updates every 30 seconds')),
      workerBanner(worker),
      h('section', { class: 'stats', 'aria-label': 'Key numbers' },
        tile(stats.missed_calls_24h, 'Missed calls · last 24 h', { href: '#inbox' }),
        tile(stats.missed_calls_7d, 'Missed calls · last 7 days', { href: '#inbox' }),
        tile(answerRate, 'Calls answered · last 7 days'),
        tile(stats.texts_sent_7d, 'Recovery texts sent · 7 days'),
        tile(stats.replies_7d, 'Caller replies · 7 days', { href: '#inbox' }),
        tile(stats.needs_attention, 'Need your attention', { href: '#review', alert: true }),
      ),
      state.clients.length === 0
        ? emptyState('Welcome to HootOwl', 'Add your first client to start rescuing missed calls.',
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openClientDialog() }, 'Add a client'))
        : h('section', {},
          h('div', { class: 'page-head' }, h('h2', {}, 'Latest missed calls'), h('span', { class: 'spacer' }),
            h('a', { href: '#inbox', class: 'btn btn-small' }, 'Open lead inbox')),
          leads.length ? leads.map(leadCard) : emptyState('No missed calls yet', 'When a call is missed, it shows up here.')),
    );
  };
  await load();
  autoRefresh(() => load().then(refreshReviewCount));
}

function emptyState(title, text, action) {
  return h('div', { class: 'card empty' }, h('h2', {}, title), h('p', {}, text), action);
}

// ---------------------------------------------------------------- lead inbox

function leadCard(lead) {
  const thread = [];
  if (lead.message_body && ['sent', 'sending', 'needs_review'].includes(lead.recovery_status)) {
    thread.push(h('div', { class: 'bubble bubble-out' },
      lead.message_body,
      h('small', {}, `Recovery text${lead.sent_at ? ` · ${timeAgo(lead.sent_at)}` : ''}`)));
  }
  for (const reply of lead.replies) {
    thread.push(h('div', { class: 'bubble bubble-in' },
      reply.body,
      h('small', {}, reply.keyword === 'opt_out' ? 'Caller opted out' : `Reply · ${timeAgo(reply.received_at)}`)));
  }

  const notes = [];
  if (lead.recovery_status === 'skipped') notes.push(SKIP_REASONS[lead.skip_reason] ?? 'Not texted.');
  if (lead.recovery_status === 'needs_review') notes.push('We could not confirm whether this text went out. See "Needs attention".');
  if (lead.recovery_status === 'failed') notes.push(`Twilio refused this text${lead.error_message ? `: ${lead.error_message}` : '.'}`);
  if (['undelivered', 'failed'].includes(lead.delivery_status)) {
    notes.push(`The phone carrier did not deliver the text${lead.error_code ? ` (Twilio error ${lead.error_code})` : ''}.`);
  }

  const delivery = DELIVERY_LABELS[lead.delivery_status];
  return h('article', { class: 'card lead' },
    h('div', { class: 'lead-head' },
      h('a', { class: 'lead-caller', href: `tel:${lead.caller_number}`, title: 'Call back' }, formatPhone(lead.caller_number)),
      h('span', { class: 'lead-meta', title: fullTime(lead.called_at) },
        `${lead.client_name} · ${DIAL_LABELS[lead.dial_call_status] ?? lead.dial_call_status ?? 'missed'} · ${timeAgo(lead.called_at)}`),
      h('span', { class: 'lead-badges' },
        lead.replies.some((r) => !r.keyword) ? badge('Replied', 'info') : null,
        recoveryBadge(lead.recovery_status),
        delivery ? badge(delivery[0], delivery[1]) : null),
    ),
    thread.length ? h('div', { class: 'thread' }, thread) : null,
    notes.map((note) => h('p', { class: 'note' }, note)),
  );
}

async function renderInbox(main) {
  let offset = 0;
  const list = h('div', {});
  const more = h('button', { class: 'btn', type: 'button' }, 'Load more');
  const moreWrap = h('div', { class: 'form-actions center' }, more);

  const loadPage = async (reset) => {
    if (reset) offset = 0;
    const { leads } = await api('GET', `/inbox${filterQuery({ limit: PAGE_SIZE, offset })}`);
    if (reset) fill(list);
    list.append(...leads.map(leadCard));
    offset += leads.length;
    moreWrap.hidden = leads.length < PAGE_SIZE;
    if (reset && leads.length === 0) {
      fill(list, emptyState('No missed calls yet',
        'Missed calls, the recovery text we sent and any replies will appear here.'));
    }
  };
  more.addEventListener('click', () => withBusy(more, () => loadPage(false)));

  const refresh = h('button', { class: 'btn', type: 'button' }, 'Refresh');
  refresh.addEventListener('click', () => withBusy(refresh, () => loadPage(true)));

  await loadPage(true);
  fill(main, pageHead('Lead inbox', refresh), list, moreWrap);
  // Auto-refresh only while the operator is looking at the first page.
  autoRefresh(() => (offset <= PAGE_SIZE ? loadPage(true) : Promise.resolve()));
}

// ---------------------------------------------------------------- clients

function recoverySwitch(client) {
  const input = h('input', { type: 'checkbox', checked: client.recovery_enabled, 'aria-label': `Recovery texts for ${client.name}` });
  input.addEventListener('change', () => withBusy(input, async () => {
    const action = input.checked ? 'enable' : 'disable';
    try {
      await api('POST', `/clients/${client.id}/recovery/${action}`);
      client.recovery_enabled = input.checked;
      toast(`Recovery texts ${input.checked ? 'on' : 'off'} for ${client.name}`);
    } catch (err) {
      input.checked = !input.checked;
      throw err;
    }
  }));
  return h('label', { class: 'switch' }, input, h('span', {}, client.recovery_enabled ? 'On' : 'Off'));
}

async function renderClients(main) {
  await reloadClients();
  const addButton = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openClientDialog() }, 'Add client');

  if (state.clients.length === 0) {
    fill(main, pageHead('Clients', addButton),
      emptyState('No clients yet', 'A client is a business whose missed calls HootOwl rescues.', null));
    return;
  }

  const rows = state.clients.map((client) => {
    const sw = recoverySwitch(client);
    sw.querySelector('input').addEventListener('change', (e) => {
      sw.querySelector('span').textContent = e.target.checked ? 'On' : 'Off';
    });
    return h('tr', {},
      h('td', {}, h('a', { href: `#client/${client.id}` }, h('strong', {}, client.name)),
        client.active ? null : h('span', {}, ' ', badge('Paused', 'warn'))),
      h('td', {}, client.routes.length
        ? client.routes.map((r) => h('div', { class: 'small nowrap' },
          formatPhone(r.twilio_number), ' → ', formatPhone(r.forward_to_number),
          r.active ? null : h('span', {}, ' ', badge('Off', 'neutral'))))
        : h('span', { class: 'muted small' }, 'No phone number yet')),
      h('td', {}, sw),
      h('td', { class: 'actions' }, h('a', { class: 'btn btn-small', href: `#client/${client.id}` }, 'Manage')),
    );
  });

  fill(main,
    pageHead('Clients', addButton),
    h('div', { class: 'card flush table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Business'), h('th', {}, 'Twilio number → business phone'),
          h('th', {}, 'Recovery texts'), h('th', {}, h('span', { class: 'muted' }, '')))),
        h('tbody', {}, rows))),
  );
}

async function renderClientDetail(main, idParam) {
  const { client } = await api('GET', `/clients/${encodeURIComponent(idParam)}`);

  // Settings form
  const form = h('form', { class: 'card' },
    h('h2', {}, 'Settings'),
    h('label', { for: 'f-name' }, 'Business name'),
    h('input', { id: 'f-name', name: 'name', type: 'text', required: true, value: client.name }),
    h('label', { for: 'f-booking' }, 'Booking page link (optional)'),
    h('input', { id: 'f-booking', name: 'booking_url', type: 'url', placeholder: 'https://hootowl.net/book/…', value: client.booking_url ?? '' }),
    h('label', { for: 'f-message' }, 'Custom recovery text (optional)'),
    h('textarea', { id: 'f-message', name: 'recovery_message', placeholder: 'Leave empty to use the standard text' }, client.recovery_message ?? ''),
    h('p', { class: 'hint' }, 'You can use {business_name} and {booking_url}. "Reply STOP to opt out." is added automatically.'),
    h('fieldset', {},
      h('legend', {}, 'Status'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'active', checked: client.active }), 'Client active (unticked = paused, no texts)'),
      h('label', { class: 'switch spaced' }, h('input', { type: 'checkbox', name: 'recovery_enabled', checked: client.recovery_enabled }), 'Send recovery texts')),
    h('p', { class: 'form-error', role: 'alert', hidden: true }),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      name: data.get('name').trim(),
      booking_url: data.get('booking_url').trim() || null,
      recovery_message: data.get('recovery_message').trim() || null,
      active: form.elements.active.checked,
      recovery_enabled: form.elements.recovery_enabled.checked,
    };
    await submitForm(form, async () => {
      await api('PATCH', `/clients/${client.id}`, body);
      await reloadClients();
      toast('Saved');
      route();
    });
  });

  // Text preview
  const preview = h('section', { class: 'card' },
    h('h2', {}, 'What callers receive'),
    h('p', { class: 'muted small' }, 'Sent from the Twilio number after a missed call.'),
    h('div', { class: 'preview' }, client.recovery_preview));

  // Phone routes
  const routeRows = client.routes.map((r) => h('tr', {},
    h('td', { class: 'nowrap' }, formatPhone(r.twilio_number)),
    h('td', { class: 'nowrap' }, formatPhone(r.forward_to_number)),
    h('td', {}, r.active ? badge('Forwarding', 'ok') : badge('Not in service', 'neutral')),
    h('td', { class: 'actions' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => openRouteDialog(client, r) }, 'Edit')),
  ));
  const routes = h('section', { class: 'card flush' },
    h('div', { class: 'page-head card-head' },
      h('h2', {}, 'Phone numbers'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => openRouteDialog(client) }, 'Add number')),
    client.routes.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Twilio number (callers dial)'), h('th', {}, 'Forwards to'), h('th', {}, 'Status'), h('th', {}, ''))),
        h('tbody', {}, routeRows)))
      : h('p', { class: 'muted card-body' }, 'No numbers yet. Add the Twilio number callers will dial.'),
  );

  const { leads } = await api('GET', `/inbox?client_id=${client.id}&limit=5`);

  fill(main,
    h('p', {}, h('a', { href: '#clients' }, '← All clients')),
    pageHead(client.name, client.active ? null : badge('Paused', 'warn')),
    h('div', { class: 'grid-2' }, form, h('div', { class: 'stack' }, preview, routes)),
    h('section', { class: 'section' },
      h('h2', {}, 'Latest missed calls'),
      leads.length ? leads.map(leadCard) : h('p', { class: 'muted' }, 'No missed calls for this client yet.')),
  );
}

// ---------------------------------------------------------------- dialogs

function friendlyError(err) {
  if (err.status === 409) return 'That Twilio number is already used by another client.';
  const phone = /^(twilio_number|forward_to_number) must be an E\.164/.exec(err.message);
  if (phone) {
    const field = phone[1] === 'twilio_number' ? 'Twilio number' : 'business phone';
    return `The ${field} doesn't look like a full phone number. Use 10 digits like (512) 555-0100, or +country code for other countries.`;
  }
  if (/booking_url must/.test(err.message)) return 'The booking link must be a full web address starting with https://';
  return err.message;
}

async function submitForm(form, fn) {
  const error = form.querySelector('.form-error');
  const button = form.querySelector('button[type="submit"]');
  error.hidden = true;
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    if (err.status !== 401) {
      error.textContent = friendlyError(err);
      error.hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

function openDialog(...content) {
  const dialog = $('#dialog');
  fill(dialog, ...content);
  dialog.showModal();
  dialog.querySelector('input, textarea')?.focus();
  return dialog;
}

function closeDialog() {
  $('#dialog').close();
}

function phoneField(id, name, label, hint, value = '') {
  return [
    h('label', { for: id }, label),
    h('input', { id, name, type: 'tel', required: true, placeholder: '(555) 123-4567', value: value ? formatPhone(value) : '' }),
    h('p', { class: 'hint' }, hint),
  ];
}

function openClientDialog() {
  const form = h('form', { method: 'dialog' },
    h('h2', {}, 'Add a client'),
    h('p', { class: 'muted small' }, 'A business whose missed calls HootOwl will rescue.'),
    h('label', { for: 'n-name' }, 'Business name'),
    h('input', { id: 'n-name', name: 'name', type: 'text', required: true, placeholder: 'Acme Plumbing' }),
    phoneField('n-twilio', 'twilio_number', 'Twilio number',
      'The number you bought in Twilio. Callers dial this one.'),
    phoneField('n-forward', 'forward_to_number', 'Business phone',
      "The business's real phone. Calls are forwarded here."),
    h('label', { for: 'n-booking' }, 'Booking page link (optional)'),
    h('input', { id: 'n-booking', name: 'booking_url', type: 'url', placeholder: 'https://hootowl.net/book/acme' }),
    h('p', { class: 'form-error', role: 'alert', hidden: true }),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add client')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      name: data.get('name').trim(),
      booking_url: data.get('booking_url').trim() || undefined,
      routes: [{
        twilio_number: toE164(data.get('twilio_number')),
        forward_to_number: toE164(data.get('forward_to_number')),
      }],
    };
    await submitForm(form, async () => {
      const { client } = await api('POST', '/clients', body);
      await reloadClients();
      closeDialog();
      toast(`${client.name} added`);
      location.hash = `#client/${client.id}`;
    });
  });
  openDialog(form);
}

function openRouteDialog(client, existing) {
  const form = h('form', { method: 'dialog' },
    h('h2', {}, existing ? 'Edit phone number' : 'Add a phone number'),
    h('p', { class: 'muted small' }, client.name),
    existing
      ? [h('label', {}, 'Twilio number'), h('p', {}, formatPhone(existing.twilio_number))]
      : phoneField('r-twilio', 'twilio_number', 'Twilio number', 'The number you bought in Twilio. Callers dial this one.'),
    phoneField('r-forward', 'forward_to_number', 'Forwards to', "The business's real phone.", existing?.forward_to_number),
    h('label', { class: 'switch spaced' },
      h('input', { type: 'checkbox', name: 'active', checked: existing ? existing.active : true }),
      'Forward calls (unticked = callers hear "not in service")'),
    h('p', { class: 'form-error', role: 'alert', hidden: true }),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save' : 'Add number')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      forward_to_number: toE164(data.get('forward_to_number')),
      active: form.elements.active.checked,
    };
    await submitForm(form, async () => {
      if (existing) {
        await api('PATCH', `/routes/${existing.id}`, body);
      } else {
        await api('POST', `/clients/${client.id}/routes`, { ...body, twilio_number: toE164(data.get('twilio_number')) });
      }
      await reloadClients();
      closeDialog();
      toast('Phone number saved');
      route();
    });
  });
  openDialog(form);
}

// ---------------------------------------------------------------- needs attention

async function renderReview(main) {
  const load = async () => {
    const [review, failed] = await Promise.all([
      api('GET', `/recovery${filterQuery({ status: 'needs_review', limit: 200 })}`),
      api('GET', `/recovery${filterQuery({ status: 'failed', limit: 200 })}`),
    ]);
    const items = [...review.recovery, ...failed.recovery];

    if (items.length === 0) {
      fill(main, pageHead('Needs attention'),
        emptyState('All clear', 'No recovery texts need checking right now.'));
      return;
    }

    const resolve = (item, status, label) => h('button', {
      class: `btn btn-small${status === 'pending' ? ' btn-primary' : ''}`,
      type: 'button',
      onclick: (event) => withBusy(event.currentTarget, async () => {
        await api('POST', `/recovery/${item.id}/resolve`, { status });
        toast(label);
        await load();
        refreshReviewCount();
      }),
    }, {
      sent: 'It was sent', failed: "Don't send", pending: item.status === 'failed' ? 'Try again' : 'Send it',
    }[status]);

    fill(main,
      pageHead('Needs attention'),
      h('p', { class: 'muted' },
        '"Check needed" means we lost contact with Twilio while sending, so the text may or may not have gone out. ',
        'Look up the caller in the Twilio console (Monitor → Logs → Messaging) before choosing.'),
      ...items.map((item) => h('article', { class: 'card lead' },
        h('div', { class: 'lead-head' },
          h('span', { class: 'lead-caller' }, formatPhone(item.caller_number)),
          h('span', { class: 'lead-meta', title: fullTime(item.created_at) }, `${item.client_name} · ${timeAgo(item.created_at)}`),
          h('span', { class: 'lead-badges' }, recoveryBadge(item.status))),
        item.message_body ? h('div', { class: 'thread' }, h('div', { class: 'bubble bubble-out' }, item.message_body)) : null,
        item.error_message
          ? h('p', { class: 'note' }, `Reason: ${item.error_message}${item.error_code ? ` (code ${item.error_code})` : ''}`)
          : null,
        h('div', { class: 'form-actions' },
          item.status === 'needs_review' ? resolve(item, 'sent', 'Marked as sent') : null,
          resolve(item, 'failed', 'Marked as not sent'),
          resolve(item, 'pending', 'Queued to send again')),
      )),
    );
  };
  await load();
  autoRefresh(load);
}

// ---------------------------------------------------------------- start

state.clientFilter = storageGet(FILTER_STORAGE) ?? '';
const savedKey = storageGet(KEY_STORAGE);
if (savedKey) {
  signIn(savedKey).then((error) => { if (error) showSignIn(error); });
} else {
  showSignIn();
}

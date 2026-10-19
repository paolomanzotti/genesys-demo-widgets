'use strict';

const config = window.RECMON_CONFIG;
const PERSIST_PREFIX = 'recmon';
const params = new URLSearchParams(window.location.search);
const currentConversationId = params.get('conversationId') || null;

const platform = window.platformClient;
const apiClient = platform.ApiClient.instance;
const usersApi = new platform.UsersApi();
const conversationsApi = new platform.ConversationsApi();
const notificationsApi = new platform.NotificationsApi();

const ui = {
  connection: document.getElementById('connection'),
  banner: document.getElementById('banner'),
  bannerTitle: document.getElementById('banner-title'),
  bannerDetail: document.getElementById('banner-detail'),
  login: document.getElementById('login'),
  calls: document.getElementById('calls'),
  log: document.getElementById('log'),
};

let clientApp = null;
let me = null;
let socket = null;

// conversationId -> { id, connectedAt, recordingState, securePause, wasActive, status, alertKind, timer, monitored }
const calls = new Map();

function initClientApp() {
  if (!params.get('gcHostOrigin') && !params.get('gcTargetEnv')) return null;
  try {
    return new window.purecloud.apps.ClientApp({
      gcHostOriginQueryParam: 'gcHostOrigin',
      gcTargetEnvQueryParam: 'gcTargetEnv',
    });
  } catch (err) {
    log(`Client App SDK non inizializzato: ${err.message}`);
    return null;
  }
}

function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('it-IT')} ${message}`;
  ui.log.prepend(item);
  while (ui.log.children.length > 50) ui.log.lastChild.remove();
  console.log('[recmon]', message);
}

function toast(title, message, type, conversationId) {
  if (!clientApp) return;
  const options = { id: `recmon-${conversationId}`, type, showCloseButton: true };
  options.timeout = type === 'error' ? 0 : 7;
  clientApp.alerting.showToastPopup(title, message, options);
}

function setConnection(text, kind) {
  ui.connection.textContent = text;
  ui.connection.className = `pill pill-${kind}`;
}

function setBanner(kind, title, detail = '') {
  ui.banner.className = `banner banner-${kind}`;
  ui.bannerTitle.textContent = title;
  ui.bannerDetail.textContent = detail;
}

// ---------- Authentication ----------

function hasPersistedToken() {
  try {
    return Boolean(JSON.parse(localStorage.getItem(`${PERSIST_PREFIX}_auth_data`))?.accessToken);
  } catch {
    return false;
  }
}

async function authenticate() {
  apiClient.setPersistSettings(true, PERSIST_PREFIX);
  apiClient.setEnvironment(clientApp?.gcEnvironment || config.defaultEnvironment);

  const redirectUri = new URL('auth_popup.html', window.location.href).href;
  const login = () =>
    apiClient.loginPKCEGrant(config.clientId, redirectUri, {
      authPopupConfiguration: { usePopup: true, popupTimeout: 120000 },
    });

  // A popup opened without a user click is blocked by the browser, so only try silently
  // when a persisted token exists; otherwise wait for the login button.
  if (hasPersistedToken()) {
    try {
      await login();
      return;
    } catch (err) {
      log(`Token salvato non valido: ${err.message || err}`);
    }
  }

  setBanner('muted', 'Accesso richiesto', 'Clicca il pulsante per autenticarti (si apre un popup).');
  ui.login.classList.remove('hidden');
  await new Promise((resolve, reject) => {
    ui.login.onclick = () => login().then(resolve, (err) => {
      setBanner('error', 'Autenticazione fallita', err.message || String(err));
      reject(err);
    });
  });
  ui.login.classList.add('hidden');
}

// ---------- Call state evaluation ----------

function agentParticipant(conversation) {
  return (conversation.participants || []).find((p) => p.user?.id === me.id || p.userId === me.id);
}

function isMonitored(conversation) {
  if (!config.monitoredQueueIds.length) return true;
  return (conversation.participants || []).some((p) => {
    const queueId = p.queue?.id || p.queueId;
    return queueId && config.monitoredQueueIds.includes(queueId);
  });
}

function recordingStateOf(conversation, agent) {
  return String(conversation.recordingState || agent?.recordingState || 'none').toLowerCase();
}

function handleConversation(conversation) {
  const agent = agentParticipant(conversation);
  if (!agent) return;

  let call = calls.get(conversation.id);
  const agentConnected = agent.state === 'connected';

  if (!agentConnected) {
    if (call && ['disconnected', 'terminated'].includes(agent.state)) endCall(call);
    return;
  }

  if (!call) {
    call = {
      id: conversation.id,
      connectedAt: agent.connectedTime ? Date.parse(agent.connectedTime) : Date.now(),
      wasActive: false,
      status: 'starting',
      alertKind: null,
      timer: null,
      monitored: isMonitored(conversation),
    };
    calls.set(call.id, call);
    log(`Chiamata ${shortId(call.id)} connessa${call.monitored ? '' : ' (coda non monitorata)'}`);
  }

  const previousState = call.recordingState;
  call.recordingState = recordingStateOf(conversation, agent);
  call.securePause = Boolean(conversation.securePause || agent.securePause);
  if (previousState !== call.recordingState) {
    log(`Chiamata ${shortId(call.id)}: recordingState=${call.recordingState}${call.securePause ? ' (secure pause)' : ''}`);
  }

  evaluate(call);
}

function evaluate(call) {
  clearTimeout(call.timer);
  if (!call.monitored) {
    call.status = 'ignored';
    return render();
  }

  if (call.recordingState === 'active') {
    if (call.alertKind) {
      toast('Registrazione ripristinata', 'La registrazione della chiamata è di nuovo attiva.', 'success', call.id);
    }
    call.wasActive = true;
    call.alertKind = null;
    call.status = 'ok';
  } else if (call.securePause || call.recordingState === 'paused') {
    call.status = 'paused';
  } else if (call.wasActive) {
    raiseAlert(call, 'stopped');
  } else {
    const elapsed = Date.now() - call.connectedAt;
    const grace = config.recordingStartGraceSeconds * 1000;
    if (elapsed >= grace) {
      raiseAlert(call, 'not_started');
    } else {
      call.status = 'starting';
      call.timer = setTimeout(() => evaluate(call), grace - elapsed);
    }
  }
  render();
}

function raiseAlert(call, kind) {
  call.status = 'alert';
  if (call.alertKind === kind) return;
  call.alertKind = kind;
  const message = kind === 'stopped'
    ? 'La registrazione si è interrotta durante la chiamata. Avvisa il cliente o il supervisore secondo la procedura.'
    : 'La registrazione non è partita. Avvisa il cliente o il supervisore secondo la procedura.';
  log(`ALLARME chiamata ${shortId(call.id)}: ${kind}`);
  toast('Registrazione non attiva', message, 'error', call.id);
}

function endCall(call) {
  clearTimeout(call.timer);
  calls.delete(call.id);
  log(`Chiamata ${shortId(call.id)} terminata`);
  render();
}

// ---------- Rendering ----------

const STATUS_LABEL = {
  ok: 'Registrazione attiva',
  paused: 'In pausa',
  starting: 'In verifica...',
  alert: 'NON REGISTRATA',
  ignored: 'Non monitorata',
};

function shortId(id) {
  return id.slice(0, 8);
}

function render() {
  const list = [...calls.values()];
  ui.calls.innerHTML = '';
  if (!list.length) {
    ui.calls.innerHTML = '<li class="empty">Nessuna chiamata attiva</li>';
  }
  for (const call of list) {
    const item = document.createElement('li');
    if (call.id === currentConversationId) item.classList.add('current');
    item.innerHTML = `<span>${shortId(call.id)}</span><span>${STATUS_LABEL[call.status]}</span>`;
    ui.calls.append(item);
  }

  const alerts = list.filter((c) => c.status === 'alert');
  clientApp?.alerting.setAttentionCount(alerts.length);

  const focus = calls.get(currentConversationId) || alerts[0] || list[0];
  if (!focus) return setBanner('muted', 'Nessuna chiamata attiva', `Monitoraggio attivo per ${me.name}`);

  switch (focus.status) {
    case 'ok': return setBanner('ok', 'Registrazione attiva');
    case 'paused': return setBanner('warn', 'Registrazione in pausa', focus.securePause ? 'Secure pause attiva' : '');
    case 'starting': return setBanner('muted', 'Verifica registrazione in corso...');
    case 'ignored': return setBanner('muted', 'Chiamata non soggetta a monitoraggio');
    default:
      return setBanner('error', 'ATTENZIONE: chiamata NON registrata',
        focus.alertKind === 'stopped' ? 'La registrazione si è interrotta.' : 'La registrazione non è partita.');
  }
}

// ---------- Notifications ----------

async function connectNotifications() {
  const channel = await notificationsApi.postNotificationsChannels();
  const topic = `v2.users.${me.id}.conversations.calls`;

  socket = new WebSocket(channel.connectUri);
  socket.onopen = async () => {
    await notificationsApi.putNotificationsChannelSubscriptions(channel.id, [{ id: topic }]);
    setConnection('Connesso', 'ok');
    log(`Sottoscritto ${topic}`);
    await loadActiveCalls();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.topicName === topic) handleConversation(message.eventBody);
    if (message.topicName === 'v2.system.socket_closing') socket.close();
  };
  socket.onclose = () => {
    setConnection('Riconnessione...', 'error');
    log('Canale notifiche chiuso, riconnessione tra 5 s');
    setTimeout(() => connectNotifications().catch(onFatal), 5000);
  };
}

async function loadActiveCalls() {
  const active = await conversationsApi.getConversationsCalls();
  for (const conversation of active.entities || []) handleConversation(conversation);
  render();
}

function onFatal(err) {
  console.error(err);
  setConnection('Errore', 'error');
  setBanner('error', 'Monitor registrazione non operativo', err.message || String(err));
}

async function main() {
  clientApp = initClientApp();
  await authenticate();
  me = await usersApi.getUsersMe();
  log(`Autenticato come ${me.name}`);
  render();
  await connectNotifications();
}

main().catch(onFatal);

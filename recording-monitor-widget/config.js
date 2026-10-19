window.RECMON_CONFIG = {
  // OAuth client (Code Authorization / PKCE) with redirect URIs:
  //   <host>/recording-monitor-widget/index.html and <host>/recording-monitor-widget/auth_popup.html
  clientId: 'REPLACE_WITH_OAUTH_CLIENT_ID',

  // Used when the widget is opened outside Genesys Cloud (no gcTargetEnv in the URL).
  defaultEnvironment: 'mypurecloud.ie',

  // Seconds to wait after the agent connects before a call without active recording is flagged.
  recordingStartGraceSeconds: 8,

  // Only calls routed through these queues are monitored. Empty = every call of the agent.
  monitoredQueueIds: [],
};

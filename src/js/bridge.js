// Calls into the Rust backend. When opened in a plain browser (for UI work),
// a small in-memory mock stands in so every screen can still be exercised.

const tauri = globalThis.__TAURI__?.core;
export const isDesktop = !!tauri;

const invoke = (cmd, args) => tauri.invoke(cmd, args);
const mock = isDesktop ? null : await import('./mock.js');
// Which profile cloud calls run as, and its region. Kept in sync by the store;
// callCtx.profileId is null for the local profile (cloud is never called).
// For kind:'server' profiles, server is true and baseUrl is the backend to hit.
export const callCtx = isDesktop ? { profileId: null, region: 'us', server: false, baseUrl: null } : mock.mockCtx;

// Legacy single-region handle kept for callers that read/write region.value;
// it maps onto the active profile's region through callCtx.
export const region = {
  get value() { return callCtx.region; },
  set value(v) { callCtx.region = v === 'eu' ? 'eu' : 'us'; },
};

export const bridge = isDesktop
  ? {
      send: (request) => invoke('send_request', { request }),
      sendStream: (request, id, onEvent) => {
        const ch = new tauri.Channel();
        ch.onmessage = onEvent;
        return invoke('send_request_stream', { request, id, onEvent: ch });
      },
      stopRequest: (id) => invoke('stop_request', { id }),
      loadtestRun: (id, request, config, onProgress) => {
        const ch = new tauri.Channel();
        ch.onmessage = onProgress;
        return invoke('loadtest_run', { id, request, config, onProgress: ch });
      },
      loadtestStop: (id) => invoke('loadtest_stop', { id }),
      grpcDescribe: (source) => invoke('grpc_describe', { source }),
      grpcCall: (source, method, message, onMessage) => {
        const ch = new tauri.Channel();
        ch.onmessage = onMessage;
        return invoke('grpc_call', { source, method, message, onMessage: ch });
      },
      pickProtoFiles: () => invoke('pick_proto_files'),
      aiSetKey: (key) => invoke('ai_set_key', { key }),
      aiHasKey: () => invoke('ai_has_key'),
      aiDeleteKey: () => invoke('ai_delete_key'),
      aiAsk: (request, id, onEvent) => {
        const ch = new tauri.Channel();
        ch.onmessage = onEvent;
        return invoke('ai_ask', { request, id, onEvent: ch });
      },
      clearCookies: () => invoke('clear_cookies'),
      listCookies: () => invoke('list_cookies'),
      setCookie: (cookie) => invoke('set_cookie', { cookie }),
      deleteCookie: (domain, path, name) => invoke('delete_cookie', { domain, path, name }),
      mockStart: (id, port, routes, onLog) => {
        const ch = new tauri.Channel();
        ch.onmessage = onLog;
        return invoke('mock_start', { id, port, routes, onLog: ch });
      },
      mockUpdate: (id, routes) => invoke('mock_update', { id, routes }),
      mockStop: (id) => invoke('mock_stop', { id }),
      pickFolder: () => invoke('pick_folder'),
      folderRead: (dir) => invoke('folder_read', { dir }),
      folderWrite: (dir, files, prune) => invoke('folder_write', { dir, files, prune }),
      folderForget: (dir) => invoke('folder_forget', { dir }),
      postman: (method, path, body) => invoke('postman_api', { method, path, body: body ?? null, profileId: callCtx.profileId ?? '', region: callCtx.region, server: !!callCtx.server, baseUrl: callCtx.baseUrl ?? null }),
      serverAuth: (opts) => invoke('server_auth', { profileId: opts.profileId, baseUrl: opts.baseUrl, email: opts.email ?? null, password: opts.password ?? null, token: opts.token ?? null }),
      setApiKey: (key, profileId, region) => invoke('set_api_key', { key, profileId, region }),
      hasApiKey: (profileId) => invoke('has_api_key', { profileId }),
      deleteApiKey: (profileId) => invoke('delete_api_key', { profileId }),
      hasLegacyKey: () => invoke('has_legacy_api_key'),
      migrateLegacyKey: (profileId) => invoke('migrate_legacy_key', { profileId }),
      secretGet: (key) => invoke('secret_get', { key }),
      secretPut: (key, value) => invoke('secret_put', { key, value }),
      trimMemory: () => invoke('trim_memory'),
      oauthFlow: (authUrl, redirectPrefix) => invoke('oauth_authorization_flow', { authUrl, redirectPrefix }),
      read: (name) => invoke('store_read', { name }),
      write: (name, value) => invoke('store_write', { name, value }),
      openTextFile: () => invoke('open_text_file'),
      pickFilePath: () => invoke('pick_file_path'),
      saveTextFile: (defaultName, content) => invoke('save_text_file', { defaultName, content }),
      saveBinaryFile: (defaultName, base64Content) => invoke('save_binary_file', { defaultName, base64Content }),
      openUrl: (url) => globalThis.__TAURI__.opener.openUrl(url),
    }
  : mock.mockBridge;

if (!isDesktop) globalThis.__dispatchMock = bridge;
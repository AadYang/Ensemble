(() => {
  const DEFAULT_ORIGIN = "https://ensemble-ai.cn";
  const SESSION_KEY = "ensemble:web-cloud-session";

  const state = {
    session: null,
    account: null,
    workspaces: [],
    snapshot: null,
    workspaceId: null,
    agentId: null,
    desktopOnline: false,
    socket: null,
    busyAgents: new Set(),
    agentStatuses: new Map(),
  };

  const el = {
    loginPanel: byId("loginPanel"),
    accountPanel: byId("accountPanel"),
    originInput: byId("originInput"),
    emailInput: byId("emailInput"),
    passwordInput: byId("passwordInput"),
    inviteInput: byId("inviteInput"),
    loginButton: byId("loginButton"),
    logoutButton: byId("logoutButton"),
    refreshButton: byId("refreshButton"),
    accountName: byId("accountName"),
    accountEmail: byId("accountEmail"),
    workspaceSelect: byId("workspaceSelect"),
    agentList: byId("agentList"),
    agentCount: byId("agentCount"),
    workspaceTitle: byId("workspaceTitle"),
    agentTitle: byId("agentTitle"),
    desktopStatus: byId("desktopStatus"),
    agentStatus: byId("agentStatus"),
    notice: byId("notice"),
    messages: byId("messages"),
    composerInput: byId("composerInput"),
    sendButton: byId("sendButton"),
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeOrigin(origin) {
    const raw = (origin || DEFAULT_ORIGIN).trim();
    const url = new URL(raw);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || !session.origin || !session.token || !session.expiresAt) return null;
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      session.origin = normalizeOrigin(session.origin);
      return session;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function api(path, options = {}) {
    if (!state.session) throw new Error("not signed in");
    return cloudFetch(state.session.origin, path, options, state.session.token);
  }

  async function cloudFetch(origin, path, options = {}, token = null) {
    const headers = new Headers(options.headers || {});
    if (options.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await fetch(`${normalizeOrigin(origin)}${path}`, { ...options, headers, credentials: "omit" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed.message || parsed.error || `${res.status} ${res.statusText}`);
      } catch (err) {
        if (err instanceof SyntaxError) throw new Error(text || `${res.status} ${res.statusText}`);
        throw err;
      }
    }
    return res.json();
  }

  async function login() {
    setNotice(null);
    const origin = normalizeOrigin(el.originInput.value || DEFAULT_ORIGIN);
    const body = {
      email: el.emailInput.value.trim(),
      password: el.passwordInput.value,
    };
    if (el.inviteInput.value.trim()) body.inviteCode = el.inviteInput.value.trim();
    el.loginButton.disabled = true;
    try {
      const res = await cloudFetch(origin, "/v1/cloud/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.session = { origin, token: res.token, expiresAt: res.expiresAt };
      state.account = res.account;
      saveSession({ ...state.session, account: res.account });
      await hydrateAccount();
      setNotice("Signed in.", "ok");
    } catch (err) {
      setNotice(err.message, "error");
    } finally {
      el.loginButton.disabled = false;
    }
  }

  async function hydrateAccount() {
    if (!state.session) return;
    const [me, list] = await Promise.all([
      api("/v1/cloud/me"),
      api("/v1/cloud/workspaces"),
    ]);
    state.account = me.account;
    state.workspaces = list.workspaces || [];
    state.workspaceId = state.workspaceId || state.workspaces[0]?.id || null;
    renderShell();
    if (state.workspaceId) await loadWorkspace(state.workspaceId);
    connectRealtime();
  }

  async function loadWorkspace(id) {
    if (!id) return;
    setNotice(null);
    const res = await api(`/v1/cloud/workspaces/${encodeURIComponent(id)}/snapshot`);
    state.workspaceId = id;
    state.snapshot = res.snapshot;
    if (!state.snapshot.agents.some((agent) => agent.id === state.agentId)) {
      state.agentId = state.snapshot.agents[0]?.id || null;
    }
    renderShell();
  }

  function connectRealtime() {
    if (!state.session) return;
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
    const url = new URL(state.session.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/cloud/realtime";
    url.search = "";
    url.searchParams.set("role", "web");
    url.searchParams.set("token", state.session.token);
    const socket = new WebSocket(url.toString());
    state.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        handleRealtime(JSON.parse(event.data));
      } catch {
        setNotice("Received an invalid realtime message.", "error");
      }
    });
    socket.addEventListener("close", () => {
      if (state.socket === socket) {
        state.socket = null;
        state.desktopOnline = false;
        renderStatus();
        if (state.session) window.setTimeout(connectRealtime, 1500);
      }
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  function handleRealtime(msg) {
    switch (msg.type) {
      case "hello":
      case "online_status":
        state.desktopOnline = !!msg.desktopOnline;
        renderStatus();
        break;
      case "remote_ack":
        setNotice("Desktop accepted the remote message.", "ok");
        break;
      case "remote_error":
        if (msg.workspaceId && msg.agentId) state.busyAgents.delete(remoteAgentKey(msg.workspaceId, msg.agentId));
        else if (msg.agentId) state.busyAgents.delete(remoteAgentKey(state.workspaceId, msg.agentId));
        setNotice(`${msg.code}: ${msg.message}`, "error");
        renderStatus();
        break;
      case "agent_status":
        state.agentStatuses.set(msg.agentId, msg.status);
        if (msg.status === "done" || msg.status === "error" || msg.status === "idle") {
          state.busyAgents.delete(remoteAgentKey(msg.workspaceId, msg.agentId));
        }
        renderStatus();
        renderAgents();
        break;
      case "agent_message":
        appendCloudMessage(msg);
        break;
    }
  }

  function appendCloudMessage(msg) {
    if (!state.snapshot || msg.workspaceId !== state.workspaceId) return;
    const messages = state.snapshot.messages;
    const index = messages.findIndex((m) => m.agentId === msg.agentId && m.seq === msg.seq);
    const next = {
      agentId: msg.agentId,
      seq: msg.seq,
      type: messageType(msg.msg),
      payload: msg.msg,
      createdAt: new Date().toISOString(),
    };
    if (index >= 0) messages[index] = next;
    else messages.push(next);
    messages.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.seq - b.seq);
    if (msg.agentId === state.agentId) renderMessages();
  }

  function sendRemote() {
    if (!state.session || !state.workspaceId || !state.agentId || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    if (!canSend()) return;
    const text = el.composerInput.value.trim();
    if (!text) return;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    state.busyAgents.add(remoteAgentKey(state.workspaceId, state.agentId));
    state.agentStatuses.set(state.agentId, "running");
    state.socket.send(JSON.stringify({
      type: "remote_send",
      requestId,
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      text,
    }));
    el.composerInput.value = "";
    renderStatus();
    renderAgents();
  }

  function canSend() {
    return !!(
      state.session &&
      state.workspaceId &&
      state.agentId &&
      state.desktopOnline &&
      state.socket &&
      state.socket.readyState === WebSocket.OPEN &&
      !state.busyAgents.has(remoteAgentKey(state.workspaceId, state.agentId))
    );
  }

  function renderShell() {
    const signedIn = !!state.session;
    el.loginPanel.classList.toggle("hidden", signedIn);
    el.accountPanel.classList.toggle("hidden", !signedIn);
    if (signedIn) {
      el.accountName.textContent = state.account?.displayName || state.account?.email || "Account";
      el.accountEmail.textContent = state.account?.email || state.session.origin;
      el.workspaceSelect.innerHTML = "";
      for (const workspace of state.workspaces) {
        const opt = document.createElement("option");
        opt.value = workspace.id;
        opt.textContent = workspace.name;
        opt.selected = workspace.id === state.workspaceId;
        el.workspaceSelect.appendChild(opt);
      }
    }
    const workspace = state.snapshot?.workspace;
    el.workspaceTitle.textContent = workspace ? workspace.name : "Cloud Workspace";
    renderAgents();
    renderMessages();
    renderStatus();
  }

  function renderAgents() {
    const agents = state.snapshot?.agents || [];
    el.agentCount.textContent = String(agents.length);
    el.agentList.innerHTML = "";
    if (!agents.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.session ? "No agents in this cloud workspace." : "Sign in to load account agents.";
      el.agentList.appendChild(empty);
      return;
    }
    for (const agent of agents) {
      const btn = document.createElement("button");
      btn.className = `agent-item${agent.id === state.agentId ? " active" : ""}`;
      btn.type = "button";
      const status = state.agentStatuses.get(agent.id) || "idle";
      btn.innerHTML = `
        <span class="agent-name"></span>
        <span class="agent-meta"></span>
      `;
      btn.querySelector(".agent-name").textContent = agent.name || agent.id;
      btn.querySelector(".agent-meta").textContent =
        `${agent.model || "model unset"} - ${status}${state.busyAgents.has(remoteAgentKey(state.workspaceId, agent.id)) ? " - remote busy" : ""}`;
      btn.addEventListener("click", () => {
        state.agentId = agent.id;
        renderShell();
      });
      el.agentList.appendChild(btn);
    }
  }

  function renderMessages() {
    const agent = currentAgent();
    el.agentTitle.textContent = agent ? agent.name : state.session ? "Select an agent." : "Sign in to view account agents.";
    el.messages.innerHTML = "";
    if (!agent) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.session ? "No agent selected." : "Sign in to open a cloud workspace.";
      el.messages.appendChild(empty);
      return;
    }
    const rows = (state.snapshot?.messages || [])
      .filter((m) => m.agentId === agent.id)
      .sort((a, b) => a.seq - b.seq);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No synced messages for this agent yet.";
      el.messages.appendChild(empty);
      return;
    }
    for (const row of rows) el.messages.appendChild(renderMessage(row));
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderMessage(row) {
    const node = document.createElement("article");
    const kind = row.type === "assistant" ? "assistant" : row.type === "user" ? "user" : row.type === "result" ? "result" : "system";
    node.className = `msg ${kind}`;
    const head = document.createElement("div");
    head.className = "msg-head";
    head.textContent = `${kind} - seq ${row.seq}`;
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = messageText(row.payload);
    node.append(head, body);
    return node;
  }

  function renderStatus() {
    el.desktopStatus.textContent = state.desktopOnline ? "desktop online" : "desktop offline";
    el.desktopStatus.className = `pill ${state.desktopOnline ? "online" : "offline"}`;
    const agentStatus = state.agentId ? state.agentStatuses.get(state.agentId) || "idle" : "idle";
    el.agentStatus.textContent = state.agentId && state.busyAgents.has(remoteAgentKey(state.workspaceId, state.agentId)) ? "remote busy" : agentStatus;
    el.agentStatus.className = `pill ${agentStatus}`;
    const sendable = canSend();
    el.sendButton.disabled = !sendable;
    el.composerInput.disabled = !state.session || !state.agentId;
    el.composerInput.placeholder = sendable
      ? "Send a remote message through the online desktop."
      : sendDisabledReason();
  }

  function sendDisabledReason() {
    if (!state.session) return "Sign in to send.";
    if (!state.agentId) return "Select an agent.";
    if (!state.desktopOnline) return "Desktop is offline.";
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return "Realtime connection is not ready.";
    if (state.busyAgents.has(remoteAgentKey(state.workspaceId, state.agentId))) return "Agent is already running a remote request.";
    return "Remote send is unavailable.";
  }

  function currentAgent() {
    return (state.snapshot?.agents || []).find((agent) => agent.id === state.agentId) || null;
  }

  function remoteAgentKey(workspaceId, agentId) {
    return `${workspaceId || ""}\u0000${agentId || ""}`;
  }

  function messageType(payload) {
    return payload && typeof payload === "object" && typeof payload.type === "string" ? payload.type : "system";
  }

  function messageText(payload) {
    if (!payload || typeof payload !== "object") return String(payload ?? "");
    if (payload.type === "user") {
      const content = payload.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
    }
    if (payload.type === "assistant") {
      const blocks = payload.message?.content || [];
      if (Array.isArray(blocks)) return blocks.map(blockText).filter(Boolean).join("\n");
    }
    if (payload.type === "stream_event") {
      const delta = payload.event?.delta;
      if (delta?.type === "text_delta") return delta.text || "";
    }
    if (payload.type === "result") return payload.subtype || "result";
    if (payload.subtype === "interrupted_turn") return "Interrupted turn context saved.";
    return JSON.stringify(payload, null, 2);
  }

  function blockText(block) {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    if (block.type === "text") return block.text || "";
    if (block.type === "tool_use") return `[tool: ${block.name || "tool"}]`;
    return "";
  }

  function setNotice(text, tone = null) {
    if (!text) {
      el.notice.className = "notice hidden";
      el.notice.textContent = "";
      return;
    }
    el.notice.className = `notice ${tone || ""}`;
    el.notice.textContent = text;
  }

  async function refresh() {
    try {
      await hydrateAccount();
      setNotice("Refreshed.", "ok");
    } catch (err) {
      setNotice(err.message, "error");
    }
  }

  function logout() {
    state.session = null;
    state.account = null;
    state.workspaces = [];
    state.snapshot = null;
    state.workspaceId = null;
    state.agentId = null;
    state.desktopOnline = false;
    state.busyAgents.clear();
    state.agentStatuses.clear();
    if (state.socket) state.socket.close();
    state.socket = null;
    localStorage.removeItem(SESSION_KEY);
    renderShell();
    setNotice(null);
  }

  el.loginButton.addEventListener("click", () => void login());
  el.logoutButton.addEventListener("click", logout);
  el.refreshButton.addEventListener("click", () => void refresh());
  el.workspaceSelect.addEventListener("change", () => void loadWorkspace(el.workspaceSelect.value));
  el.sendButton.addEventListener("click", sendRemote);
  el.composerInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") sendRemote();
  });

  el.originInput.value = DEFAULT_ORIGIN;
  const restored = loadSession();
  if (restored) {
    state.session = { origin: restored.origin, token: restored.token, expiresAt: restored.expiresAt };
    state.account = restored.account || null;
    void hydrateAccount().catch((err) => {
      setNotice(err.message, "error");
      logout();
    });
  } else {
    renderShell();
  }
})();

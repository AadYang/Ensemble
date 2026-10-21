const authErr = document.getElementById("auth-err");
const authPanel = document.getElementById("auth-panel");
const appPanel = document.getElementById("app-panel");
const boxesEl = document.getElementById("boxes");
const paneEl = document.getElementById("pane");
const mastEnd = document.getElementById("mast-end");
const secret = document.getElementById("secret");
const tokenKey = "po_token";
const pickKey = "po_pick";

let selectedId = sessionStorage.getItem(pickKey) || "";
let cubbies = [];

function token() {
  return localStorage.getItem(tokenKey) || "";
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showAuth(err) {
  authPanel.hidden = false;
  appPanel.hidden = true;
  mastEnd.replaceChildren();
  authErr.hidden = !err;
  authErr.textContent = err || "";
}

function showApp(username) {
  authPanel.hidden = true;
  appPanel.hidden = false;
  mastEnd.replaceChildren();
  const who = document.createElement("span");
  who.textContent = username;
  const out = document.createElement("button");
  out.type = "button";
  out.id = "logout";
  out.textContent = "退出";
  out.onclick = logout;
  mastEnd.append(who, out);
}

function showLogin() {
  document.getElementById("login-form").hidden = false;
  document.getElementById("register-form").hidden = true;
  document.getElementById("tab-login").classList.add("on");
  document.getElementById("tab-register").classList.remove("on");
  authErr.hidden = true;
}
function showRegister() {
  document.getElementById("login-form").hidden = true;
  document.getElementById("register-form").hidden = false;
  document.getElementById("tab-register").classList.add("on");
  document.getElementById("tab-login").classList.remove("on");
  authErr.hidden = true;
}
document.getElementById("tab-login").onclick = showLogin;
document.getElementById("tab-register").onclick = showRegister;

document.getElementById("login-form").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const out = await api("api/login", {
      method: "POST",
      body: JSON.stringify({ username: fd.get("username"), password: fd.get("password") }),
    });
    localStorage.setItem(tokenKey, out.token);
    await load();
  } catch (err) {
    showAuth(err.message);
  }
};

document.getElementById("register-form").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const out = await api("api/register", {
      method: "POST",
      body: JSON.stringify({
        username: fd.get("username"),
        password: fd.get("password"),
        inviteCode: fd.get("inviteCode"),
      }),
    });
    localStorage.setItem(tokenKey, out.token);
    await load();
  } catch (err) {
    showAuth(err.message);
  }
};

async function logout() {
  try { await api("api/logout", { method: "POST" }); } catch { /* ignore */ }
  localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(pickKey);
  selectedId = "";
  cubbies = [];
  showAuth();
}

document.getElementById("create-form").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const box = await api("api/mailboxes", {
    method: "POST",
    body: JSON.stringify({ name: fd.get("name") }),
  });
  e.target.reset();
  selectedId = box.id;
  sessionStorage.setItem(pickKey, selectedId);
  openSecret(box);
  await renderBoxes();
};

function closeSecret() {
  if (typeof secret.close === "function") secret.close();
  secret.removeAttribute("open");
}

document.getElementById("sec-close").onclick = closeSecret;
document.getElementById("sec-x").onclick = closeSecret;
secret.addEventListener("click", (e) => {
  if (e.target === secret) closeSecret();
});
secret.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSecret();
});

async function copyText(id, btn) {
  await navigator.clipboard.writeText(document.getElementById(id).textContent);
  const prev = btn.textContent;
  btn.textContent = "已复制";
  setTimeout(() => { btn.textContent = prev; }, 1200);
}
document.getElementById("copy-json").onclick = (e) => copyText("sec-json", e.currentTarget);
document.getElementById("copy-hook").onclick = (e) => copyText("sec-hook", e.currentTarget);

function openSecret(box) {
  document.getElementById("sec-comm").textContent = box.commCode;
  document.getElementById("sec-bind").textContent = box.bindCode;
  document.getElementById("sec-json").textContent = box.mcp.json;
  document.getElementById("sec-hook").textContent = box.mcp.hookJson || "";
  secret.showModal();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatCall(call) {
  if (!call) return "";
  if (call.status === "waiting") return "等待来电";
  if (call.status === "incoming") return `来电 ${call.peerName}`;
  if (call.status === "ringing") return `呼叫 ${call.peerName}`;
  if (call.status === "connected") return `已接通 ${call.peerName}`;
  return "";
}

function hungHint(b) {
  if (b.unread > 0 && !b.listening) return `有 ${b.unread} 条未读，agent 已停。去客户端说「继续」。`;
  return "";
}

function newestFirst(messages) {
  return [...messages].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function cubbyButton(b) {
  const on = b.id === selectedId ? " on" : "";
  const call = formatCall(b.call);
  return `<button type="button" class="cubby${on}" data-id="${b.id}">
    <h3>${escapeHtml(b.name)}</h3>
    <div class="meta">
      <span class="dot ${b.bound ? "on" : ""}"></span>
      <span>${b.bound ? "在线" : "空闲"}</span>
      <span>${escapeHtml(b.commCode)}</span>
      ${call ? `<span class="call ${escapeHtml(b.call?.status || "")}">${escapeHtml(call)}</span>` : ""}
    </div>
  </button>`;
}

async function refreshLog() {
  if (!selectedId) return;
  const tape = paneEl.querySelector(".tape");
  if (!tape) return;
  const data = await api(`api/mailboxes/${selectedId}/messages?limit=80`);
  const rows = newestFirst(data.messages);
  tape.innerHTML = rows.length
    ? rows.map((m) => {
      const mine = m.from === data.commCode;
      const who = mine
        ? `你 → ${m.toName || m.to}`
        : `${m.fromName || m.from} → 你`;
      return `<li class="msg ${mine ? "mine" : "theirs"}">
        <time datetime="${escapeHtml(new Date(m.createdAt).toISOString())}">${escapeHtml(formatTime(m.createdAt))}</time>
        <div>
          <div class="who">${escapeHtml(who)}</div>
          <div class="body">${escapeHtml(m.body)}</div>
        </div>
      </li>`;
    }).join("")
    : `<li class="empty">还没有消息。接通后双方发出和收到的都会记在这里，最新在上。</li>`;
}

function paintCubbyMeta(article, b) {
  const dot = article.querySelector(".dot");
  if (dot) dot.classList.toggle("on", !!b.bound);
  const meta = article.querySelector(".meta");
  if (!meta) return;
  const call = formatCall(b.call);
  meta.innerHTML = `
    <span class="dot ${b.bound ? "on" : ""}"></span>
    <span>${b.bound ? "在线" : "空闲"}</span>
    <span>${escapeHtml(b.commCode)}</span>
    ${call ? `<span class="call ${escapeHtml(b.call?.status || "")}">${escapeHtml(call)}</span>` : ""}`;
}

async function refreshPresence() {
  const { mailboxes } = await api("api/mailboxes");
  cubbies = mailboxes;
  for (const b of mailboxes) {
    const el = boxesEl.querySelector(`.cubby[data-id="${b.id}"]`);
    if (el) paintCubbyMeta(el, b);
  }
  const hung = paneEl.querySelector(".hung");
  const current = mailboxes.find((x) => x.id === selectedId);
  if (hung && current) hung.textContent = hungHint(current);
}

async function refreshContacts() {
  const ul = paneEl.querySelector(".contacts");
  if (!ul || !selectedId) return;
  const data = await api(`api/mailboxes/${selectedId}/contacts`);
  ul.innerHTML = data.contacts.length
    ? data.contacts.map((c) => `
      <li data-comm="${escapeHtml(c.commCode)}">
        <span class="src">${sourceLabel(c.source)}</span>
        <span>${escapeHtml(c.name)}${c.alias ? ` / ${escapeHtml(c.alias)}` : ""}</span>
        <code>${escapeHtml(c.commCode)}</code>
        ${c.isDefault ? `<span class="on">默认</span>` : `<button type="button" data-act="default">默认</button>`}
        ${c.source === "saved" ? `<button type="button" data-act="forget">删除</button>` : ""}
      </li>`).join("")
    : `<li class="src">还没有联系人。同账号第二只信箱会自动出现。</li>`;
}

function sourceLabel(src) {
  if (src === "account") return "同账号";
  if (src === "thread") return "往来";
  return "已保存";
}

function renderPane() {
  const b = cubbies.find((x) => x.id === selectedId);
  if (!b) {
    paneEl.innerHTML = cubbies.length
      ? `<p class="empty">从左侧选一只信箱。</p>`
      : `<p class="empty">开一只信箱，把绑定码写进 MCP。</p>`;
    return;
  }
  paneEl.innerHTML = `
    <div class="pane-head">
      <div>
        <h2>${escapeHtml(b.name)}</h2>
        <code>${escapeHtml(b.commCode)}</code>
      </div>
      <div class="actions">
        <button type="button" data-act="copy">复制通讯码</button>
        <button type="button" data-act="reset">重置绑定码</button>
        <button type="button" data-act="del">删除</button>
      </div>
    </div>
    <p class="hung">${escapeHtml(hungHint(b))}</p>
    <ul class="contacts"><li class="src">加载联系人…</li></ul>
    <form class="contact-form" data-act="add-contact">
      <input name="comm" placeholder="对方通讯码" required maxlength="12" />
      <input name="alias" placeholder="别名，可选" maxlength="40" />
      <button type="submit">添加</button>
    </form>
    <div class="tape-head"><span>消息</span><span>最新在上</span></div>
    <ol class="tape"><li class="empty">加载消息…</li></ol>`;
  void refreshContacts();
  void refreshLog();
}

async function renderBoxes() {
  const { mailboxes } = await api("api/mailboxes");
  cubbies = mailboxes;
  if (!selectedId || !mailboxes.some((b) => b.id === selectedId)) {
    selectedId = mailboxes[0]?.id || "";
    if (selectedId) sessionStorage.setItem(pickKey, selectedId);
  }
  boxesEl.innerHTML = mailboxes.length
    ? mailboxes.map(cubbyButton).join("")
    : `<p class="hint">还没有信箱。</p>`;
  renderPane();
}

boxesEl.onclick = (e) => {
  const cubby = e.target.closest(".cubby");
  if (!cubby) return;
  selectedId = cubby.dataset.id;
  sessionStorage.setItem(pickKey, selectedId);
  for (const el of boxesEl.querySelectorAll(".cubby")) {
    el.classList.toggle("on", el.dataset.id === selectedId);
  }
  renderPane();
};

paneEl.onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.type === "submit" || !selectedId) return;
  const act = btn.dataset.act;
  const current = cubbies.find((x) => x.id === selectedId);
  if (act === "copy" && current) {
    await navigator.clipboard.writeText(current.commCode);
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = "复制通讯码"; }, 1200);
    return;
  }
  if (act === "reset" && confirm("重置后旧 MCP 配置立刻失效，确定？")) {
    const out = await api(`api/mailboxes/${selectedId}/reset-bind`, { method: "POST" });
    openSecret({ commCode: current?.commCode, bindCode: out.bindCode, mcp: out.mcp });
    await renderBoxes();
  }
  if (act === "del" && confirm("删除这只信箱？未读邮件一并丢掉。")) {
    await api(`api/mailboxes/${selectedId}`, { method: "DELETE" });
    selectedId = "";
    sessionStorage.removeItem(pickKey);
    await renderBoxes();
  }
  if (act === "default") {
    const comm = btn.closest("li")?.dataset.comm;
    if (!comm) return;
    await api(`api/mailboxes/${selectedId}/contacts/${comm}/default`, { method: "POST" });
    await refreshContacts();
  }
  if (act === "forget" && confirm("从已保存联系人里去掉？往来和同账号信箱仍会留在名单里。")) {
    const comm = btn.closest("li")?.dataset.comm;
    if (!comm) return;
    await api(`api/mailboxes/${selectedId}/contacts/${comm}`, { method: "DELETE" });
    await refreshContacts();
  }
};

paneEl.onsubmit = async (e) => {
  const form = e.target.closest("form");
  if (!form || form.dataset.act !== "add-contact" || !selectedId) return;
  e.preventDefault();
  const fd = new FormData(form);
  await api(`api/mailboxes/${selectedId}/contacts`, {
    method: "POST",
    body: JSON.stringify({ commCode: fd.get("comm"), alias: fd.get("alias") || "", default: true }),
  });
  form.reset();
  await refreshContacts();
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let pollTimer = null;
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (appPanel.hidden) return;
    try { await refreshPresence(); } catch { /* ignore */ }
    try { await refreshLog(); } catch { /* ignore */ }
  }, 2000);
}

async function load() {
  if (!token()) return showAuth();
  try {
    const me = await api("api/me");
    showApp(me.username);
    await renderBoxes();
    startPoll();
  } catch {
    localStorage.removeItem(tokenKey);
    showAuth();
  }
}

load();

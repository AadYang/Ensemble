const authErr = document.getElementById("auth-err");
const authPanel = document.getElementById("auth-panel");
const appPanel = document.getElementById("app-panel");
const boxesEl = document.getElementById("boxes");
const secret = document.getElementById("secret");
const tokenKey = "po_token";

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
  authErr.hidden = !err;
  authErr.textContent = err || "";
}

function showApp(username) {
  authPanel.hidden = true;
  appPanel.hidden = false;
  document.getElementById("who").textContent = username;
}

document.getElementById("tab-login").onclick = () => {
  document.getElementById("login-form").hidden = false;
  document.getElementById("register-form").hidden = true;
  document.getElementById("tab-login").classList.add("on");
  document.getElementById("tab-register").classList.remove("on");
};
document.getElementById("tab-register").onclick = () => {
  document.getElementById("login-form").hidden = true;
  document.getElementById("register-form").hidden = false;
  document.getElementById("tab-register").classList.add("on");
  document.getElementById("tab-login").classList.remove("on");
};

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

document.getElementById("logout").onclick = async () => {
  try { await api("api/logout", { method: "POST" }); } catch { /* ignore */ }
  localStorage.removeItem(tokenKey);
  showAuth();
};

document.getElementById("create-form").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const box = await api("api/mailboxes", {
    method: "POST",
    body: JSON.stringify({ name: fd.get("name") }),
  });
  e.target.reset();
  openSecret(box);
  await renderBoxes();
};

document.getElementById("sec-close").onclick = () => secret.close();
document.getElementById("copy-json").onclick = async () => {
  await navigator.clipboard.writeText(document.getElementById("sec-json").textContent);
};
document.getElementById("copy-hook").onclick = async () => {
  await navigator.clipboard.writeText(document.getElementById("sec-hook").textContent);
};

function openSecret(box) {
  document.getElementById("sec-comm").textContent = box.commCode;
  document.getElementById("sec-bind").textContent = box.bindCode;
  document.getElementById("sec-json").textContent = box.mcp.json;
  document.getElementById("sec-hook").textContent = box.mcp.hookJson || "";
  secret.showModal();
}

function formatMsg(m, me) {
  const mine = m.from === me;
  const who = mine
    ? `you → ${m.to}${m.toName ? ` ${m.toName}` : ""}`
    : `${m.from}${m.fromName ? ` ${m.fromName}` : ""} → you`;
  return `<div class="${mine ? "mine" : "theirs"}">[${new Date(m.createdAt).toISOString()}] ${escapeHtml(who.trim())}\n${escapeHtml(m.body)}</div>`;
}

async function refreshLog(article) {
  const id = article.dataset.id;
  const data = await api(`api/mailboxes/${id}/messages?limit=50`);
  let log = article.querySelector(".log");
  if (!log) {
    log = document.createElement("pre");
    log.className = "log";
    article.appendChild(log);
  }
  log.innerHTML = data.messages.length
    ? data.messages.map((m) => formatMsg(m, data.commCode)).join("\n\n")
    : `<span class="empty">还没有消息。接通后双方 send 的发出和收到都会显示在这里。</span>`;
}

function formatCall(call) {
  if (!call) return "";
  if (call.status === "waiting") return "等待来电";
  if (call.status === "incoming") return `来电 ${call.peerName} ${call.peerCode}`;
  if (call.status === "ringing") return `正在呼叫 ${call.peerName} ${call.peerCode}`;
  if (call.status === "connected") return `已接通 ${call.peerName} ${call.peerCode}`;
  return "";
}

function hungHint(b) {
  if (b.unread > 0 && !b.listening) {
    return `有 ${b.unread} 条未读，agent 已结束 turn。去客户端说「继续」。`;
  }
  return "";
}

async function refreshPresence() {
  const { mailboxes } = await api("api/mailboxes");
  for (const b of mailboxes) {
    const article = boxesEl.querySelector(`article[data-id="${b.id}"]`);
    if (!article) continue;
    const dot = article.querySelector(".dot");
    if (dot) {
      dot.classList.toggle("on", !!b.bound);
      const meta = dot.parentElement;
      if (meta && meta.childNodes[1]) meta.childNodes[1].textContent = b.bound ? "MCP 在线 " : "未占用 ";
    }
    const el = article.querySelector(".call");
    if (el) {
      el.className = `call ${b.call?.status || ""}`;
      el.textContent = formatCall(b.call);
    }
    const hung = article.querySelector(".hung");
    if (hung) hung.textContent = hungHint(b);
  }
}

let pollTimer = null;
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (appPanel.hidden) return;
    try { await refreshPresence(); } catch { /* ignore */ }
    for (const article of boxesEl.querySelectorAll("article.box")) {
      try { await refreshLog(article); } catch { /* ignore */ }
    }
  }, 2000);
}

async function renderBoxes() {
  const { mailboxes } = await api("api/mailboxes");
  boxesEl.innerHTML = mailboxes.length
    ? mailboxes.map((b) => `
      <article class="box" data-id="${b.id}" data-comm="${escapeHtml(b.commCode)}">
        <h3>${escapeHtml(b.name)}</h3>
        <div class="meta"><span class="dot ${b.bound ? "on" : ""}"></span>${b.bound ? "MCP 在线" : "未占用"} <span class="call ${escapeHtml(b.call?.status || "")}">${formatCall(b.call)}</span></div>
        <p class="hung">${escapeHtml(hungHint(b))}</p>
        <p>通讯码 <code>${b.commCode}</code></p>
        <p class="meta">绑定码已隐藏。丢失请重置（旧配置会失效）。</p>
        <div class="actions">
          <button type="button" data-act="copy">${b.commCode}</button>
          <button type="button" data-act="reset">重置绑定码</button>
          <button type="button" data-act="del">删除</button>
        </div>
        <ul class="contacts"><li class="src">加载联系人…</li></ul>
        <form class="contact-form" data-act="add-contact">
          <input name="comm" placeholder="对方通讯码" required maxlength="12" />
          <input name="alias" placeholder="别名，可选" maxlength="40" />
          <button type="submit">添加联系人</button>
        </form>
        <pre class="log"><span class="empty">加载消息…</span></pre>
      </article>`).join("")
    : `<p class="hint">还没有信箱。</p>`;
  for (const article of boxesEl.querySelectorAll("article.box")) {
    try { await refreshLog(article); } catch { /* ignore */ }
    try { await refreshContacts(article); } catch { /* ignore */ }
  }
}

function sourceLabel(src) {
  if (src === "account") return "同账号";
  if (src === "thread") return "往来";
  return "已保存";
}

async function refreshContacts(article) {
  const id = article.dataset.id;
  const data = await api(`api/mailboxes/${id}/contacts`);
  const ul = article.querySelector(".contacts");
  if (!ul) return;
  ul.innerHTML = data.contacts.length
    ? data.contacts.map((c) => `
      <li data-comm="${escapeHtml(c.commCode)}">
        <span class="src">${sourceLabel(c.source)}</span>
        <span>${escapeHtml(c.name)}${c.alias ? ` / ${escapeHtml(c.alias)}` : ""}</span>
        <code>${escapeHtml(c.commCode)}</code>
        ${c.isDefault ? `<span class="on">默认</span>` : `<button type="button" data-act="default">设为默认</button>`}
        ${c.source === "saved" ? `<button type="button" data-act="forget">删除</button>` : ""}
      </li>`).join("")
    : `<li class="src">还没有联系人。同账号开第二只信箱会自动出现；跨账号在下面填通讯码加一次。</li>`;
}

boxesEl.onclick = async (e) => {
  const btn = e.target.closest("button");
  const article = e.target.closest("article");
  if (!btn || !article) return;
  if (btn.type === "submit") return;
  const id = article.dataset.id;
  const act = btn.dataset.act;
  if (act === "copy") {
    await navigator.clipboard.writeText(btn.textContent.trim());
    return;
  }
  if (act === "reset" && confirm("重置后旧 MCP 配置立刻失效，确定？")) {
    const out = await api(`api/mailboxes/${id}/reset-bind`, { method: "POST" });
    openSecret({ commCode: article.querySelector("code").textContent, bindCode: out.bindCode, mcp: out.mcp });
    await renderBoxes();
  }
  if (act === "del" && confirm("删除这只信箱？未读邮件一并丢掉。")) {
    await api(`api/mailboxes/${id}`, { method: "DELETE" });
    await renderBoxes();
  }
  if (act === "default") {
    const comm = btn.closest("li")?.dataset.comm;
    if (!comm) return;
    await api(`api/mailboxes/${id}/contacts/${comm}/default`, { method: "POST" });
    await refreshContacts(article);
  }
  if (act === "forget" && confirm("从已保存联系人里去掉？往来和同账号信箱仍会留在名单里。")) {
    const comm = btn.closest("li")?.dataset.comm;
    if (!comm) return;
    await api(`api/mailboxes/${id}/contacts/${comm}`, { method: "DELETE" });
    await refreshContacts(article);
  }
};

boxesEl.onsubmit = async (e) => {
  const form = e.target.closest("form");
  const article = e.target.closest("article");
  if (!form || !article || form.dataset.act !== "add-contact") return;
  e.preventDefault();
  const fd = new FormData(form);
  await api(`api/mailboxes/${article.dataset.id}/contacts`, {
    method: "POST",
    body: JSON.stringify({ commCode: fd.get("comm"), alias: fd.get("alias") || "", default: true }),
  });
  form.reset();
  await refreshContacts(article);
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

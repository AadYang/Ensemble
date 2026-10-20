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

function openSecret(box) {
  document.getElementById("sec-comm").textContent = box.commCode;
  document.getElementById("sec-bind").textContent = box.bindCode;
  document.getElementById("sec-json").textContent = box.mcp.json;
  secret.showModal();
}

async function renderBoxes() {
  const { mailboxes } = await api("api/mailboxes");
  boxesEl.innerHTML = mailboxes.length
    ? mailboxes.map((b) => `
      <article class="box" data-id="${b.id}">
        <h3>${escapeHtml(b.name)}</h3>
        <div class="meta"><span class="dot ${b.bound ? "on" : ""}"></span>${b.bound ? "MCP 在线" : "未占用"}</div>
        <p>通讯码 <code>${b.commCode}</code></p>
        <p class="meta">绑定码已隐藏。丢失请重置（旧配置会失效）。</p>
        <div class="actions">
          <button type="button" data-act="copy">${b.commCode}</button>
          <button type="button" data-act="reset">重置绑定码</button>
          <button type="button" data-act="del">删除</button>
        </div>
      </article>`).join("")
    : `<p class="hint">还没有信箱。</p>`;
}

boxesEl.onclick = async (e) => {
  const btn = e.target.closest("button");
  const article = e.target.closest("article");
  if (!btn || !article) return;
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
  } catch {
    localStorage.removeItem(tokenKey);
    showAuth();
  }
}

load();

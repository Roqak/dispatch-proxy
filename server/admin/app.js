/* Dispatch admin panel — vanilla JS, no build step, no dependencies. */
(() => {
  "use strict";

  const TOKEN_KEY = "dispatch_admin_token";
  const ROLES = ["viewer", "editor", "creator", "admin"];
  const ALL_WORKSPACES = "all workspaces";
  const AUDIT_LIMIT = 500;

  const $ = (id) => document.getElementById(id);

  const els = {
    loginView: $("view-login"),
    appView: $("view-app"),
    loginForm: $("login-form"),
    loginEmail: $("login-email"),
    loginPassword: $("login-password"),
    loginPasswordLabel: $("login-password-label"),
    loginError: $("login-error"),
    loginSubmit: $("login-submit"),
    modeToggle: $("mode-toggle"),
    logoutBtn: $("logout-btn"),
    meEmail: $("me-email"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    panels: { users: $("tab-users"), settings: $("tab-settings"), audit: $("tab-audit") },
    addForm: $("add-user-form"),
    newEmail: $("new-email"),
    newPassword: $("new-password"),
    newRole: $("new-role"),
    addUserSubmit: $("add-user-submit"),
    usersRefresh: $("users-refresh"),
    usersBody: $("users-body"),
    settingsToggle: $("allow-registration"),
    auditRefresh: $("audit-refresh"),
    auditBody: $("audit-body"),
    toast: $("toast"),
  };

  let me = null;
  let loginMode = "credentials";
  let toastTimer = null;

  /* ---- session storage ---- */

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  /* ---- fetch wrapper ---- */

  async function api(path, options) {
    const opts = options || {};
    const headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const token = getToken();
    if (token) headers.Authorization = "Bearer " + token;

    let response;
    try {
      response = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, error: "Network error: could not reach the server." };
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = null; }
    }

    if (!response.ok) {
      const message = data && typeof data === "object" && data.error
        ? String(data.error)
        : "Request failed with status " + response.status + ".";
      if (response.status === 401) {
        clearToken();
        showLogin();
      }
      return { ok: false, status: response.status, error: message };
    }
    return { ok: true, status: response.status, data };
  }

  /* ---- small DOM helpers ---- */

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function labeledCell(label, className, content) {
    const cell = el("td", className, content);
    cell.setAttribute("data-label", label);
    return cell;
  }

  function statusRow(body, colSpan, text) {
    body.textContent = "";
    const row = el("tr");
    const cell = el("td", "empty-cell", text);
    cell.colSpan = colSpan;
    row.appendChild(cell);
    body.appendChild(row);
  }

  /* ---- toast ---- */

  function toast(message, kind) {
    els.toast.textContent = message;
    els.toast.className = "toast " + (kind === "error" ? "error" : "ok") + " show";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), kind === "error" ? 5000 : 2800);
  }

  const toastErr = (message) => toast(message, "error");
  const toastOk = (message) => toast(message, "ok");

  function fail(result) {
    toastErr(result && result.error ? result.error : "Request failed.");
  }

  /* ---- formatting ---- */

  function fmtTime(value) {
    if (value === null || value === undefined || value === "") return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function grantsText(grants) {
    return grants === null || grants === undefined ? ALL_WORKSPACES : grants.join(", ");
  }

  function parseGrants(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed.toLowerCase() === ALL_WORKSPACES) return null;
    const list = trimmed.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    return list.length ? list : null;
  }

  function statusClass(status) {
    const n = Number(status);
    if (!Number.isFinite(n)) return "";
    if (n >= 500) return "bad";
    if (n >= 400) return "warn";
    if (n >= 200 && n < 400) return "ok";
    return "";
  }

  /* ---- view switching ---- */

  function showInlineLoginError(message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  }

  function showLogin(message) {
    const wasInApp = !els.appView.hidden;
    me = null;
    els.appView.hidden = true;
    els.loginView.hidden = false;
    els.usersBody.textContent = "";
    els.auditBody.textContent = "";
    if (message !== undefined) showInlineLoginError(message);
    if (wasInApp) {
      els.loginPassword.value = "";
      try { els.loginEmail.focus(); } catch (err) { /* ignore */ }
    }
  }

  function showApp() {
    els.loginView.hidden = true;
    els.appView.hidden = false;
  }

  function switchTab(name) {
    if (!els.panels[name]) return;
    for (const tab of els.tabs) tab.classList.toggle("active", tab.dataset.tab === name);
    for (const key of Object.keys(els.panels)) els.panels[key].hidden = key !== name;
    if (name === "users") loadUsers();
    else if (name === "settings") loadSettings();
    else if (name === "audit") loadAudit();
  }

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  /* ---- session flow ---- */

  // Every admin page load funnels through GET /me; admin API calls are only
  // made when /me reports role "admin".
  async function enterApp() {
    if (!getToken()) { showLogin(); return false; }
    const result = await api("/me");
    if (!result.ok) {
      if (result.status !== 401) { showLogin(); fail(result); }
      return false; // 401 was already routed to the login view by the wrapper
    }
    const user = result.data && result.data.user ? result.data.user : null;
    if (!user || user.role !== "admin") {
      showLogin("Signed in, but this account does not have admin rights.");
      return false;
    }
    me = user;
    els.meEmail.textContent = user.email || "";
    showApp();
    switchTab("users");
    return true;
  }

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.loginError.hidden = true;
    els.loginError.textContent = "";
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    if (loginMode === "credentials" && (!email || !password)) {
      showInlineLoginError("Enter your email and password.");
      return;
    }
    if (loginMode === "admin" && !password) {
      showInlineLoginError("Enter the server admin password.");
      return;
    }
    els.loginSubmit.disabled = true;
    const result = loginMode === "admin"
      ? await api("/auth/admin-login", { method: "POST", body: { password } })
      : await api("/auth/login", { method: "POST", body: { email, password } });
    els.loginSubmit.disabled = false;
    if (!result.ok) {
      let message = result.error || "Sign-in failed.";
      if (result.status === 403) {
        message += " This server may require the shared admin password — try “Use server admin password instead” below.";
      }
      showInlineLoginError(message);
      return;
    }
    const token = result.data && result.data.token;
    if (!token) { showInlineLoginError("Sign-in did not return a token."); return; }
    setToken(token);
    await enterApp();
  });

  els.modeToggle.addEventListener("click", () => {
    loginMode = loginMode === "credentials" ? "admin" : "credentials";
    const admin = loginMode === "admin";
    els.loginForm.dataset.mode = loginMode;
    els.loginPasswordLabel.textContent = admin ? "Admin password" : "Password";
    els.modeToggle.textContent = admin ? "Use email & password instead" : "Use server admin password instead";
    els.loginError.hidden = true;
    els.loginError.textContent = "";
    try { (admin ? els.loginPassword : els.loginEmail).focus(); } catch (err) { /* ignore */ }
  });

  els.logoutBtn.addEventListener("click", () => {
    // Best-effort revoke on the server (needs the Bearer header, so fire it
    // before dropping the token); outcome is irrelevant for the local logout.
    if (getToken()) { api("/auth/logout", { method: "POST" }); }
    clearToken();
    showLogin();
  });

  /* ---- users ---- */

  async function loadUsers() {
    statusRow(els.usersBody, 5, "Loading users…");
    const result = await api("/admin/users");
    if (!result.ok) {
      if (result.status !== 401) fail(result);
      return;
    }
    if (!Array.isArray(result.data)) { toastErr("Unexpected response from GET /admin/users."); return; }
    renderUsers(result.data);
  }

  function renderUsers(users) {
    els.usersBody.textContent = "";
    if (!users.length) { statusRow(els.usersBody, 5, "No users yet. Create the first one above."); return; }
    for (const user of users) els.usersBody.appendChild(userRow(user));
  }

  function userRow(user) {
    const row = el("tr");
    const id = String(user.id);

    const emailCell = labeledCell("Email", "u-email");
    const emailMain = el("span", "u-email-main");
    emailMain.appendChild(el("span", null, user.email || id));
    emailMain.appendChild(el("span", "u-id muted", "#" + id));
    emailCell.appendChild(emailMain);

    const roleCell = labeledCell("Role", "u-role");
    const roleSelect = document.createElement("select");
    for (const role of ROLES) {
      const option = el("option", null, role);
      option.value = role;
      roleSelect.appendChild(option);
    }
    roleSelect.value = typeof user.role === "string" ? user.role : "viewer";
    roleSelect.addEventListener("change", async () => {
      const next = roleSelect.value;
      const result = await api("/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: { role: next } });
      if (!result.ok) {
        roleSelect.value = typeof user.role === "string" ? user.role : "viewer";
        fail(result);
        return;
      }
      user.role = next;
      toastOk("Role for " + (user.email || id) + " set to " + next + ".");
    });
    roleCell.appendChild(roleSelect);

    const grantsCell = labeledCell("Workspace grants", "u-grants");
    const grantsInput = document.createElement("input");
    grantsInput.type = "text";
    grantsInput.className = "grants-input";
    grantsInput.value = grantsText(user.workspace_grants);
    grantsInput.spellcheck = false;
    grantsInput.title = "Comma-separated workspace IDs, or “all workspaces” for access to everything.";
    grantsInput.addEventListener("change", async () => {
      const parsed = parseGrants(grantsInput.value);
      const result = await api("/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: { workspace_grants: parsed } });
      if (!result.ok) {
        fail(result);
        grantsInput.value = grantsText(user.workspace_grants);
        return;
      }
      user.workspace_grants = parsed;
      grantsInput.value = grantsText(parsed);
      toastOk(parsed === null
        ? "Access for " + (user.email || id) + " set to all workspaces."
        : "Access for " + (user.email || id) + " limited to " + parsed.length + (parsed.length === 1 ? " workspace." : " workspaces."));
    });
    grantsCell.appendChild(grantsInput);

    const createdCell = labeledCell("Created", "u-created muted", fmtTime(user.created_at));

    const actionsCell = labeledCell("Actions", "u-actions");
    const actionsRow = el("div", "action-row");

    const resetBtn = el("button", "btn sm", "Reset password");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", async () => {
      const password = window.prompt("New password for " + (user.email || id) + ":");
      if (password === null) return;
      if (password.length === 0) { toastErr("Password cannot be empty."); return; }
      resetBtn.disabled = true;
      const result = await api("/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: { password } });
      resetBtn.disabled = false;
      if (!result.ok) { fail(result); return; }
      toastOk("Password updated for " + (user.email || id) + ".");
    });

    const deleteBtn = el("button", "btn sm danger-ghost", "Delete");
    deleteBtn.type = "button";
    const isSelf = me !== null && String(me.id) === id;
    deleteBtn.disabled = isSelf;
    if (isSelf) deleteBtn.title = "You cannot delete your own account.";
    deleteBtn.addEventListener("click", async () => {
      const target = user.email || id;
      if (!window.confirm("Delete user " + target + "? This cannot be undone.")) return;
      deleteBtn.disabled = true;
      const result = await api("/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
      if (!result.ok) { deleteBtn.disabled = false; fail(result); return; }
      toastOk("Deleted " + target + ".");
      loadUsers();
    });

    actionsRow.appendChild(resetBtn);
    actionsRow.appendChild(deleteBtn);
    actionsCell.appendChild(actionsRow);

    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(grantsCell);
    row.appendChild(createdCell);
    row.appendChild(actionsCell);
    return row;
  }

  els.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = els.newEmail.value.trim();
    const password = els.newPassword.value;
    if (!email || !password) { toastErr("Email and password are required to create a user."); return; }
    els.addUserSubmit.disabled = true;
    const result = await api("/admin/users", { method: "POST", body: { email, password, role: els.newRole.value } });
    els.addUserSubmit.disabled = false;
    if (!result.ok) { fail(result); return; }
    els.newEmail.value = "";
    els.newPassword.value = "";
    els.newRole.value = "viewer";
    toastOk("User " + email + " created.");
    loadUsers();
  });

  els.usersRefresh.addEventListener("click", () => loadUsers());

  /* ---- settings ---- */

  async function loadSettings() {
    els.settingsToggle.disabled = true;
    const result = await api("/admin/settings");
    els.settingsToggle.disabled = false;
    if (!result.ok) {
      if (result.status !== 401) fail(result);
      return;
    }
    els.settingsToggle.checked = Boolean(result.data && result.data.allow_registration);
  }

  els.settingsToggle.addEventListener("change", async () => {
    const desired = els.settingsToggle.checked;
    els.settingsToggle.disabled = true;
    const result = await api("/admin/settings", { method: "PATCH", body: { allow_registration: desired } });
    els.settingsToggle.disabled = false;
    if (!result.ok) {
      els.settingsToggle.checked = !desired;
      fail(result);
      return;
    }
    toastOk(desired ? "Registration is now open to new sign-ups." : "Registration is now disabled.");
  });

  /* ---- audit ---- */

  async function loadAudit() {
    statusRow(els.auditBody, 5, "Loading audit log…");
    const result = await api("/admin/audit?limit=" + AUDIT_LIMIT);
    if (!result.ok) {
      if (result.status !== 401) fail(result);
      return;
    }
    if (!Array.isArray(result.data)) { toastErr("Unexpected response from GET /admin/audit."); return; }
    renderAudit(result.data);
  }

  function renderAudit(entries) {
    els.auditBody.textContent = "";
    if (!entries.length) { statusRow(els.auditBody, 5, "No audit entries recorded yet."); return; }
    for (const entry of entries) {
      const row = el("tr");
      row.appendChild(labeledCell("Time", "a-time", fmtTime(entry.ts)));
      const userText = entry.email
        ? entry.email
        : (entry.user_id !== null && entry.user_id !== undefined ? "#" + entry.user_id : "—");
      row.appendChild(labeledCell("User", "a-user", userText));
      row.appendChild(labeledCell("Action", "a-action mono", entry.action || "—"));
      const request = ((entry.method || "?") + " " + (entry.path || "")).trim();
      row.appendChild(labeledCell("Request", "a-request mono", request));
      const statusCell = labeledCell("Status", "a-status");
      const badge = el("span", "status " + statusClass(entry.status),
        entry.status === null || entry.status === undefined ? "—" : String(entry.status));
      statusCell.appendChild(badge);
      row.appendChild(statusCell);
      els.auditBody.appendChild(row);
    }
  }

  els.auditRefresh.addEventListener("click", () => loadAudit());

  /* ---- boot ---- */

  (async () => {
    if (getToken()) {
      await enterApp();
    } else {
      showLogin();
    }
  })();
})();
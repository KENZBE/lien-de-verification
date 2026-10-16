const loginSection = document.getElementById("login-section");
const dashboard = document.getElementById("dashboard");
const pageError = document.getElementById("page-error");
const adminStatus = document.getElementById("admin-status");
const requestsList = document.getElementById("requests-list");
const accessTokenKey = "activecards.supabase.access-token";
const refreshTokenKey = "activecards.supabase.refresh-token";
let accessToken = sessionStorage.getItem(accessTokenKey);
let refreshToken = sessionStorage.getItem(refreshTokenKey);
let refreshPromise = null;

function saveTokens(session) {
  accessToken = session.accessToken;
  refreshToken = session.refreshToken;
  sessionStorage.setItem(accessTokenKey, accessToken);
  sessionStorage.setItem(refreshTokenKey, refreshToken);
}

function clearTokens() {
  accessToken = null;
  refreshToken = null;
  sessionStorage.removeItem(accessTokenKey);
  sessionStorage.removeItem(refreshTokenKey);
}

async function refreshAdminSession() {
  if (!refreshToken) return false;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const response = await fetch("/api/admin/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });
    const result = await response.json();
    if (!response.ok) {
      clearTokens();
      return false;
    }
    saveTokens(result);
    return true;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function api(url, options = {}, retryAfterRefresh = true) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(url, { ...options, headers });

  if (response.status === 401 && retryAfterRefresh && url !== "/api/admin/login") {
    if (await refreshAdminSession()) return api(url, options, false);
  }
  if (response.status === 204) return {};
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "La requête a échoué.");
  return body;
}

function showError(message) {
  pageError.textContent = message;
  pageError.hidden = false;
}

function showAdmin(message, isError = false) {
  adminStatus.textContent = message;
  adminStatus.classList.toggle("admin-alert", isError);
  adminStatus.classList.toggle("error", isError);
}

function makeRequestCard(request) {
  const article = document.createElement("article");
  article.className = "admin-card";

  const title = document.createElement("h3");
  title.textContent = `AC-${request.id} · ${request.card} · ${request.customer_name}`;
  article.append(title);

  const email = document.createElement("p");
  email.textContent = `E-mail : ${request.customer_email}`;
  article.append(email);

  const date = document.createElement("p");
  date.textContent = `Reçue le : ${new Date(request.created_at).toLocaleString("fr-FR")}`;
  article.append(date);

  const status = document.createElement("p");
  const statusLabels = { pending: "En attente", accepted: "Acceptée", rejected: "Refusée" };
  status.textContent = `Statut : ${statusLabels[request.status] || "Inconnu"}`;
  article.append(status);

  const messageLabel = document.createElement("strong");
  messageLabel.textContent = "Message du client";
  article.append(messageLabel);
  const message = document.createElement("p");
  message.textContent = request.message;
  article.append(message);

  const responseForm = document.createElement("form");
  responseForm.className = "admin-response-form";
  const responseId = `response-${request.id}`;
  const responseLabel = document.createElement("label");
  responseLabel.htmlFor = responseId;
  responseLabel.textContent = "Votre réponse à inclure dans le reçu envoyé au client";
  const responseInput = document.createElement("textarea");
  responseInput.id = responseId;
  responseInput.name = "response";
  responseInput.rows = 5;
  responseInput.maxLength = 1500;
  responseInput.required = true;
  responseInput.placeholder = "Rédigez ici votre message de suivi administratif.";
  responseInput.value = request.admin_response || "";
  responseForm.append(responseLabel, responseInput);

  const help = document.createElement("p");
  help.className = "admin-response-help";
  help.textContent = "N’incluez aucun code, identifiant, solde ou estimation de valeur de carte.";
  responseForm.append(help);

  const actions = document.createElement("div");
  actions.className = "admin-actions";
  [
    ["accepted", "Dossier valide"],
    ["rejected", "Dossier invalide"],
    ["pending", "En attente"]
  ].forEach(([value, label]) => {
    const button = document.createElement("button");
    button.type = "submit";
    button.dataset.status = value;
    button.textContent = label;
    actions.append(button);
  });
  responseForm.append(actions);
  responseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (!(button instanceof HTMLButtonElement) || !button.dataset.status) return;
    const buttons = [...responseForm.querySelectorAll("button")];
    buttons.forEach((item) => { item.disabled = true; });
    responseInput.disabled = true;
    showAdmin("");
    try {
      const result = await api(`/api/admin/requests/${request.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: button.dataset.status, message: responseInput.value })
      });
      showAdmin(result.message);
      await loadRequests();
    } catch (error) {
      showAdmin(error.message, true);
    } finally {
      buttons.forEach((item) => { item.disabled = false; });
      responseInput.disabled = false;
    }
  });
  article.append(responseForm);
  return article;
}

async function loadRequests() {
  const result = await api("/api/admin/requests");
  requestsList.replaceChildren();
  if (result.requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucune demande pour le moment.";
    requestsList.append(empty);
    return;
  }
  result.requests.forEach((request) => requestsList.append(makeRequestCard(request)));
}

async function showDashboard(result) {
  loginSection.hidden = true;
  dashboard.hidden = false;
  pageError.hidden = true;
  document.getElementById("admin-account").textContent = `Connecté : ${result.adminEmail}`;
  document.getElementById("notification-email").value = result.notificationEmail || "";
  const systemStatus = document.getElementById("system-status");
  systemStatus.textContent = result.smtpReady
    ? "Envoi d’e-mails configuré."
    : "Envoi d’e-mails non configuré : ajoutez les variables SMTP dans Render. Les demandes ne seront pas acceptées avant cette configuration.";
  systemStatus.classList.toggle("error", !result.smtpReady);
  try {
    await loadRequests();
  } catch (error) {
    showAdmin(error.message, true);
  }
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pageError.hidden = true;
  const values = new FormData(event.currentTarget);
  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        email: values.get("email"),
        password: values.get("password")
      })
    });
    saveTokens(result);
    event.currentTarget.reset();
    await showDashboard(await api("/api/admin/session"));
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  try {
    const result = await api("/api/admin/settings/notification-email", {
      method: "PUT",
      body: JSON.stringify({ email: values.get("email") })
    });
    document.getElementById("notification-email").value = result.notificationEmail;
    showAdmin("Adresse de réception enregistrée dans Supabase.");
  } catch (error) {
    showAdmin(error.message, true);
  }
});

document.getElementById("refresh-button").addEventListener("click", async () => {
  try {
    await loadRequests();
    showAdmin("Liste actualisée depuis Supabase.");
  } catch (error) {
    showAdmin(error.message, true);
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await fetch("/api/admin/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, refreshToken })
    });
  } catch (error) {
    console.error("Logout request failed", error);
  } finally {
    clearTokens();
    dashboard.hidden = true;
    loginSection.hidden = false;
    showAdmin("");
  }
});

async function initialize() {
  if (!accessToken && !refreshToken) return;
  try {
    if (!accessToken && !(await refreshAdminSession())) return;
    await showDashboard(await api("/api/admin/session"));
  } catch (error) {
    clearTokens();
    showError(error.message);
  }
}

initialize();

const path = require("node:path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const requiredEnvironment = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ADMIN_USER_IDS"
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
if (missingEnvironment.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
}

const adminUserIds = new Set(
  process.env.SUPABASE_ADMIN_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
);
if (adminUserIds.size === 0 || [...adminUserIds].some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
  throw new Error("SUPABASE_ADMIN_USER_IDS must contain one or more comma-separated Supabase user UUIDs.");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const app = express();
const port = Number(process.env.PORT) || 3000;
const allowedCards = new Set([
  "Transcash", "Steam", "PCS", "Google Play", "PaysafeCard",
  "Neosurf", "iTunes", "PlayStation", "PayPal"
]);
const statuses = {
  accepted: { label: "dossier marqué comme valide", subject: "Mise à jour de votre demande" },
  rejected: { label: "dossier marqué comme invalide", subject: "Mise à jour de votre demande" },
  pending: { label: "dossier mis en attente", subject: "Mise à jour de votre demande" }
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "12kb", type: "application/json" }));

function createMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
  });
}

const mailer = createMailer();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });

function createAuthClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n").slice(0, maxLength) : "";
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requestBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

async function adminRequired(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) return sendError(res, 401, "Connectez-vous à l’espace admin.");

  try {
    const { data, error } = await supabase.auth.getUser(match[1]);
    if (error || !data.user || !adminUserIds.has(data.user.id)) {
      return sendError(res, 401, "Session admin invalide ou expirée. Reconnectez-vous.");
    }
    req.adminUser = data.user;
    next();
  } catch (error) {
    next(error);
  }
}

function handleSupabaseError(error, operation) {
  if (!error) return null;
  console.error(`Supabase ${operation} failed`, error);
  return error;
}

app.get("/health", async (_req, res, next) => {
  try {
    const { error } = await supabase.from("requests").select("id").limit(1);
    if (handleSupabaseError(error, "health check")) {
      return res.status(503).send("Supabase unavailable");
    }
    return res.status(200).send("ok");
  } catch (error) {
    next(error);
  }
});

app.post("/api/requests", submitLimiter, async (req, res, next) => {
  try {
    const body = requestBody(req);
    const card = normalizeText(body.card, 40);
    const name = normalizeText(body.name, 100);
    const email = normalizeText(body.email, 254).toLowerCase();
    const message = normalizeText(body.message, 2000);
    if (!allowedCards.has(card) || name.length < 2 || !isValidEmail(email) || message.length < 5) {
      return sendError(res, 400, "Vérifiez la carte choisie, votre nom, votre adresse e-mail et votre message.");
    }
    const containsCardData = /\b(?:pin|code|cryptogramme|solde|recharge|num[eé]ro de carte)\b/i.test(message)
      || /\d{12,}/.test(message)
      || /\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){2,4}\b/i.test(message)
      || /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,4}\b/i.test(message);
    if (containsCardData) {
      return sendError(res, 400, "N’envoyez aucune donnée de carte (code, numéro ou solde). Reformulez votre message sans ces informations.");
    }
    const { data: request, error: insertError } = await supabase
      .from("requests")
      .insert({ card, customer_name: name, customer_email: email, message })
      .select("id, created_at")
      .single();
    if (handleSupabaseError(insertError, "insert request")) {
      return sendError(res, 503, "La demande n’a pas pu être enregistrée. Réessayez ultérieurement.");
    }

    const reference = `AC-${request.id}`;
    if (!mailer) {
      return res.status(201).json({
        message: `Demande enregistrée sous ${reference} et visible dans l’espace admin. La notification e-mail n’a pas été envoyée : le service SMTP n’est pas configuré.`,
        notificationSent: false
      });
    }

    const { data: setting, error: settingError } = await supabase
      .from("site_settings")
      .select("setting_value")
      .eq("setting_key", "notification_email")
      .maybeSingle();
    if (handleSupabaseError(settingError, "read notification email")) {
      return res.status(201).json({
        message: `Demande enregistrée sous ${reference} et visible dans l’espace admin. La notification e-mail n’a pas été envoyée car les réglages Supabase sont momentanément indisponibles.`,
        notificationSent: false
      });
    }
    const notificationEmail = setting?.setting_value || "";
    if (!isValidEmail(notificationEmail)) {
      return res.status(201).json({
        message: `Demande enregistrée sous ${reference} et visible dans l’espace admin. Configurez l’adresse de réception dans l’administration pour recevoir les e-mails.`,
        notificationSent: false
      });
    }

    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: notificationEmail,
        replyTo: email,
        subject: `Nouvelle demande ${reference} - ${card}`,
        text: `Référence : ${reference}\nDate : ${new Date(request.created_at).toISOString()}\nCarte : ${card}\nNom : ${name}\nE-mail : ${email}\n\nMessage :\n${message}`
      });
    } catch (error) {
      console.error("Failed to notify the configured recipient for request", request.id, error);
      return res.status(201).json({
        message: `Demande enregistrée sous ${reference} et visible dans l’espace admin. L’e-mail de notification n’a pas pu être envoyé ; vérifiez la configuration SMTP.`,
        notificationSent: false
      });
    }

    return res.status(201).json({
      message: `Demande envoyée sous ${reference}. Vous recevrez un suivi par e-mail.`,
      notificationSent: true
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", loginLimiter, async (req, res, next) => {
  try {
    const body = requestBody(req);
    const email = normalizeText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!isValidEmail(email) || password.length === 0 || password.length > 256) {
      return sendError(res, 400, "Saisissez votre adresse e-mail et votre mot de passe.");
    }

    const authClient = createAuthClient();
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.user || !data.session) {
      return sendError(res, 401, "Identifiants incorrects.");
    }
    if (!adminUserIds.has(data.user.id)) {
      await authClient.auth.signOut({ scope: "local" });
      return sendError(res, 403, "Ce compte n’est pas autorisé à accéder à l’administration.");
    }

    return res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/refresh", loginLimiter, async (req, res, next) => {
  try {
    const refreshToken = normalizeText(requestBody(req).refreshToken, 4096);
    if (!refreshToken) return sendError(res, 400, "Session expirée. Reconnectez-vous.");
    const authClient = createAuthClient();
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.user || !data.session || !adminUserIds.has(data.user.id)) {
      return sendError(res, 401, "Session admin expirée. Reconnectez-vous.");
    }
    return res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/logout", async (req, res, next) => {
  try {
    const body = requestBody(req);
    const accessToken = normalizeText(body.accessToken, 4096);
    const refreshToken = normalizeText(body.refreshToken, 4096);
    if (!accessToken || !refreshToken) return res.status(204).end();
    const authClient = createAuthClient();
    const { error: sessionError } = await authClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    if (sessionError) return res.status(204).end();
    const { error } = await authClient.auth.signOut({ scope: "local" });
    if (error) console.error("Supabase admin logout failed", error);
    return res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/session", adminRequired, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("site_settings")
      .select("setting_value")
      .eq("setting_key", "notification_email")
      .maybeSingle();
    if (handleSupabaseError(error, "read admin settings")) {
      return sendError(res, 503, "Impossible de charger les réglages Supabase.");
    }
    return res.json({
      authenticated: true,
      adminEmail: req.adminUser.email,
      notificationEmail: data?.setting_value || "",
      smtpReady: Boolean(mailer)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/requests", adminRequired, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("requests")
      .select("id, card, customer_name, customer_email, message, admin_response, status, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (handleSupabaseError(error, "list requests")) {
      return sendError(res, 503, "Impossible de charger les demandes depuis Supabase.");
    }
    return res.json({ requests: data });
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/settings/notification-email", adminRequired, async (req, res, next) => {
  try {
    const email = normalizeText(requestBody(req).email, 254).toLowerCase();
    if (!isValidEmail(email)) return sendError(res, 400, "Saisissez une adresse e-mail valide.");
    const { error } = await supabase
      .from("site_settings")
      .upsert({ setting_key: "notification_email", setting_value: email }, { onConflict: "setting_key" });
    if (handleSupabaseError(error, "save notification email")) {
      return sendError(res, 503, "L’adresse e-mail n’a pas pu être enregistrée dans Supabase.");
    }
    return res.json({ notificationEmail: email });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/requests/:id/status", adminRequired, async (req, res, next) => {
  const id = Number(req.params.id);
  const body = requestBody(req);
  const status = normalizeText(body.status, 20);
  const adminResponse = normalizeText(body.message, 1500);
  const statusCopy = statuses[status];
  if (!Number.isSafeInteger(id) || id < 1 || !statusCopy) {
    return sendError(res, 400, "Demande ou statut invalide.");
  }
  if (adminResponse.length < 2) {
    return sendError(res, 400, "Rédigez le message qui accompagnera le reçu envoyé au client.");
  }
  const containsSensitiveInformation = /\b(?:pin|code|cryptogramme|solde|recharge|num[eé]ro de carte|identifiant de carte|prix|montant|valeur)\b/i.test(adminResponse)
    || /\b(?:carte\b.{0,40}\b(?:valide|invalide|authentique|utilis[eé]e|fonctionne)|(?:valide|invalide|authentique|utilis[eé]e|fonctionne)\b.{0,40}\bcarte)\b/i.test(adminResponse)
    || /\d{12,}/.test(adminResponse)
    || /\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){2,4}\b/i.test(adminResponse)
    || /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,4}\b/i.test(adminResponse);
  if (containsSensitiveInformation) {
    return sendError(res, 400, "Le message ne peut pas contenir de code, identifiant, solde ou estimation de valeur de carte.");
  }
  if (!mailer) return sendError(res, 503, "Configurez le service d’envoi d’e-mails avant de répondre.");

  try {
    const { data: request, error: requestError } = await supabase
      .from("requests")
      .select("id, customer_name, customer_email")
      .eq("id", id)
      .maybeSingle();
    if (handleSupabaseError(requestError, "read request status")) {
      return sendError(res, 503, "Impossible de charger la demande depuis Supabase.");
    }
    if (!request) return sendError(res, 404, "Cette demande n’existe pas.");

    const { error: updateError } = await supabase
      .from("requests")
      .update({ status, admin_response: adminResponse, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (handleSupabaseError(updateError, "update request status")) {
      return sendError(res, 503, "Le statut n’a pas pu être enregistré dans Supabase.");
    }

    const reference = `AC-${request.id}`;
    const text = [
      `Bonjour ${request.customer_name.split(/\s+/)[0]},`,
      "",
      `Mise à jour du dossier : ${statusCopy.label}.`,
      "",
      adminResponse,
      "",
      `Référence de votre demande : ${reference}`,
      "",
      "Active Cards"
    ].join("\n");
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: request.customer_email,
        subject: statusCopy.subject,
        text
      });
    } catch (error) {
      console.error("Failed to send status email for request", id, error);
      return sendError(res, 502, "Le statut a été enregistré dans Supabase, mais l’e-mail n’a pas pu être envoyé. Réessayez avec le même bouton.");
    }
    return res.json({ message: `Statut mis à jour et e-mail envoyé au client (${statusCopy.label}).` });
  } catch (error) {
    next(error);
  }
});

function servePage(filename) {
  return (_req, res, next) => {
    res.sendFile(path.join(__dirname, filename), (error) => error && next(error));
  };
}

app.get("/", servePage("index.html"));
app.get("/formulaire.html", servePage("formulaire.html"));
app.get("/formulaire.js", servePage("formulaire.js"));
app.get("/admin", servePage("admin.html"));
app.get("/admin.html", servePage("admin.html"));
app.get("/admin.js", servePage("admin.js"));
app.get("/styles.css", servePage("styles.css"));
app.use("/assets", express.static(path.join(__dirname, "assets"), {
  dotfiles: "deny",
  index: false,
  maxAge: process.env.NODE_ENV === "production" ? "1d" : 0
}));

app.use((error, _req, res, _next) => {
  console.error("Unhandled server error", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

app.listen(port, "0.0.0.0", () => console.log(`Active Cards server listening on port ${port}`));

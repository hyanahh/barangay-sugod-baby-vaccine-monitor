require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;
const required = ["MONGODB_URI", "SESSION_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
for (const k of required) if (!process.env[k]) { console.error(`Missing ${k} in environment`); process.exit(1); }

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("Connected to MongoDB");
    const email = process.env.ADMIN_EMAIL.toLowerCase();
    if (!(await User.findOne({ email }))) {
      await User.create({ name: process.env.ADMIN_NAME || "System Administrator", email,
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), role: "Administrator", active: true });
      console.log("Initial administrator account created.");
    }
  })
  .catch(e => { console.error("MongoDB connection error:", e.message); process.exit(1); });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["Parent/Guardian", "Healthcare Worker", "Administrator"], required: true },
  phone: { type: String, trim: true, maxlength: 30 },
  babyIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Baby" }],
  active: { type: Boolean, default: true },
  emailOptIn: { type: Boolean, default: true },
  smsOptIn: { type: Boolean, default: false },
  pushOptIn: { type: Boolean, default: false },
  pushSubscriptions: [{ endpoint: String, expirationTime: { type: Number, default: null }, keys: { p256dh: String, auth: String } }]
}, { timestamps: true });

const babySchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  birthDate: { type: Date, required: true },
  sex: { type: String, enum: ["Female", "Male", "Not specified"], default: "Not specified" },
  guardianName: { type: String, required: true, trim: true, maxlength: 100 },
  contactNumber: { type: String, trim: true, maxlength: 30 },
  guardianEmail: { type: String, trim: true, lowercase: true, maxlength: 150 },
  barangay: { type: String, trim: true, maxlength: 100 },
  notes: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

const vaccineSchema = new mongoose.Schema({
  baby: { type: mongoose.Schema.Types.ObjectId, ref: "Baby", required: true, index: true },
  vaccineName: { type: String, required: true, trim: true, maxlength: 100 },
  dose: { type: String, trim: true, maxlength: 50 },
  dateGiven: { type: Date, default: null },
  nextDueDate: { type: Date, default: null, index: true },
  status: { type: String, enum: ["Completed", "Scheduled", "Missed"], default: "Scheduled" },
  administeredBy: { type: String, trim: true, maxlength: 100 },
  notes: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  baby: { type: mongoose.Schema.Types.ObjectId, ref: "Baby", default: null },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
  readAt: { type: Date, default: null }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Baby = mongoose.model("Baby", babySchema);
const Vaccine = mongoose.model("Vaccine", vaccineSchema);
const Message = mongoose.model("Message", messageSchema);

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname + "/public"));
app.use(session({
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: "sessions" }),
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(async (req, res, next) => {
  if (req.session.user) {
    try { req.currentUser = await User.findById(req.session.user.id).select("-passwordHash"); }
    catch (_) {}
  }
  res.locals.user = req.currentUser || null;
  next();
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
function auth(req, res, next) {
  if (!req.currentUser || !req.currentUser.active) return res.redirect("/login");
  next();
}
function roles(...allowed) {
  return (req, res, next) => {
    if (!req.currentUser || !allowed.includes(req.currentUser.role)) return res.status(403).send("You do not have permission to access this page.");
    next();
  };
}
function validDate(v) { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function canSeeBaby(user, baby) {
  if (["Administrator", "Healthcare Worker"].includes(user.role)) return true;
  return user.babyIds.some(id => id.toString() === baby._id.toString());
}
// Monthly monitoring mode: notifications are sent after a health worker saves a vaccine record
// with a next due date, only to linked parent accounts that enabled the relevant channel.
function normalizePhilippineNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("09") && digits.length === 11) digits = "63" + digits.slice(1);
  else if (digits.startsWith("9") && digits.length === 10) digits = "63" + digits;
  else if (digits.startsWith("639") && digits.length === 12) { /* already normalized */ }
  else throw new Error("Invalid Philippine mobile number. Use 09XXXXXXXXX or +639XXXXXXXXX.");
  return digits;
}
async function sendTextBeeSms(number, message) {
  const apiKey = process.env.TEXTBEE_API_KEY;
  if (!apiKey) return { sent: false, reason: "TextBee is not configured. Add TEXTBEE_API_KEY to the environment." };
  const normalized = "+" + normalizePhilippineNumber(number);
  const response = await fetch(`${process.env.TEXTBEE_BASE_URL || "https://api.textbee.dev/api/v1"}/gateway/send-sms`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ recipients: [normalized], message })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false || data.error) {
    throw new Error(data.error || data.message || `TextBee request failed (${response.status}).`);
  }
  return { sent: true, status: "Accepted by TextBee", batchId: data.smsBatchId || data.batchId || null };
}
const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
async function sendWebPush(parent, title, body, url = "/my-babies") {
  if (!pushConfigured) return { sent: false, reason: "Web Push is not configured. Add VAPID keys to the environment." };
  if (!parent.pushOptIn || !parent.pushSubscriptions?.length) return { sent: false, reason: "Parent has not enabled Web Push on a device." };
  const payload = JSON.stringify({ title, body, url });
  const remaining = [];
  let sent = false;
  for (const sub of parent.pushSubscriptions) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: sub.keys }, payload);
      remaining.push(sub); sent = true;
    } catch (error) {
      if (error.statusCode !== 404 && error.statusCode !== 410) remaining.push(sub);
      console.error("Web Push error:", error.message);
    }
  }
  if (remaining.length !== parent.pushSubscriptions.length) {
    parent.pushSubscriptions = remaining;
    await parent.save();
  }
  return { sent, reason: sent ? null : "No active push subscription could receive the notification." };
}
async function notifyParent(parent, message, title = "Barangay Sugod Vaccine Reminder") {
  const results = { sms: null, push: null };
  if (parent.smsOptIn && parent.phone) {
    try { results.sms = await sendTextBeeSms(parent.phone, message); }
    catch (error) { console.error("TextBee SMS error:", error.message); results.sms = { sent: false, reason: error.message }; }
  }
  results.push = await sendWebPush(parent, title, message);
  return results;
}
async function notifyOptedInParents(baby, vaccine) {
  if (!vaccine.nextDueDate) return { skipped: true, reason: "No next due date was entered." };
  const parents = await User.find({ role: "Parent/Guardian", active: true, babyIds: baby._id, $or: [{ smsOptIn: true }, { pushOptIn: true }] });
  if (!parents.length) return { skipped: true, reason: "No linked parent has enabled SMS or Web Push." };
  const due = vaccine.nextDueDate.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila" });
  const message = `Barangay Sugod Baby Vaccine Monitoring: ${baby.fullName}'s ${vaccine.vaccineName} record was updated. Next due date: ${due}. Please contact the Barangay Health Center to confirm the schedule.`;
  const results = [];
  for (const parent of parents) results.push(await notifyParent(parent, message));
  return { results };
}
function getMonthRange(value) {
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(String(value || ""));
  let year = match ? Number(match[1]) : new Date().getFullYear();
  let month = match ? Number(match[2]) - 1 : new Date().getMonth();
  if (month < 0 || month > 11) { year = new Date().getFullYear(); month = new Date().getMonth(); }
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  return { start, end, value: `${year}-${String(month + 1).padStart(2, "0")}`, label: start.toLocaleDateString("en-PH", { month: "long", year: "numeric" }) };
}
function monthVaccineFilter(start, end) {
  return { $or: [
    { dateGiven: { $gte: start, $lt: end } },
    { nextDueDate: { $gte: start, $lt: end } }
  ] };
}

app.get("/login", (req, res) => res.render("login", { title: "Sign in", error: null }));
app.post("/login", loginLimiter, async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const user = await User.findOne({ email });
  if (!user || !user.active || !(await bcrypt.compare(req.body.password || "", user.passwordHash)))
    return res.status(401).render("login", { title: "Sign in", error: "Invalid login or account inactive." });
  req.session.regenerate(err => {
    if (err) return res.status(500).send("Could not start session.");
    req.session.user = { id: user._id.toString() }; res.redirect("/dashboard");
  });
});
app.get("/register", (req, res) => res.render("register", { title: "Parent registration", error: null }));
app.post("/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name?.trim() || !email?.trim() || !password || password.length < 10) throw new Error("Provide your name, email, and a password of at least 10 characters.");
    if (await User.findOne({ email: email.toLowerCase().trim() })) throw new Error("An account with this email already exists.");
    const smsOptIn = req.body.smsOptIn === "on";
    if (smsOptIn) normalizePhilippineNumber(phone);
    const user = await User.create({ name, email, phone, role: "Parent/Guardian", smsOptIn, passwordHash: await bcrypt.hash(password, 12) });
    req.session.user = { id: user._id.toString() }; res.redirect("/my-babies");
  } catch (e) { res.status(400).render("register", { title: "Parent registration", error: e.message }); }
});
app.post("/logout", auth, (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/dashboard", auth, async (req, res) => {
  if (req.currentUser.role === "Parent/Guardian") return res.redirect("/my-babies");
  const month = getMonthRange(req.query.month);
  const filter = monthVaccineFilter(month.start, month.end);
  const [babyCount, vaccines] = await Promise.all([
    Baby.countDocuments(), Vaccine.find(filter).populate("baby").sort({ dateGiven: -1, nextDueDate: 1 })
  ]);
  const stats = {
    babyCount,
    total: vaccines.length,
    completed: vaccines.filter(v => v.status === "Completed").length,
    scheduled: vaccines.filter(v => v.status === "Scheduled").length,
    missed: vaccines.filter(v => v.status === "Missed").length
  };
  res.render("dashboard", { title: "Monthly monitoring", stats, vaccines, month });
});

app.get("/babies", auth, roles("Administrator", "Healthcare Worker"), async (req, res) => {
  const q = (req.query.q || "").trim().slice(0, 80);
  const filter = q ? { $or: ["fullName","guardianName","barangay"].map(k => ({ [k]: { $regex: escapeRegex(q), $options: "i" } })) } : {};
  const babies = await Baby.find(filter).sort({ fullName: 1 });
  res.render("babies", { title: "Baby records", babies, q });
});
app.get("/babies/new", auth, roles("Administrator", "Healthcare Worker"), (req, res) => res.render("baby-form", { title: "Register baby", baby: {}, error: null }));
app.post("/babies", auth, roles("Administrator", "Healthcare Worker"), async (req, res) => {
  try {
    const { fullName, birthDate, sex, guardianName, contactNumber, guardianEmail, barangay, notes } = req.body;
    if (!fullName?.trim() || !guardianName?.trim() || !validDate(birthDate)) throw new Error("Baby name, guardian name, and valid birth date are required.");
    const baby = await Baby.create({ fullName, birthDate: validDate(birthDate), sex, guardianName, contactNumber, guardianEmail, barangay, notes });
    if (req.body.parentEmail) {
      const parent = await User.findOne({ email: req.body.parentEmail.toLowerCase().trim(), role: "Parent/Guardian" });
      if (parent) { parent.babyIds.addToSet(baby._id); await parent.save(); }
    }
    res.redirect(`/babies/${baby._id}`);
  } catch (e) { res.status(400).render("baby-form", { title: "Register baby", baby: req.body, error: e.message }); }
});
app.get("/babies/:id", auth, roles("Administrator", "Healthcare Worker"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const baby = await Baby.findById(req.params.id); if (!baby) return res.sendStatus(404);
  const vaccines = await Vaccine.find({ baby: baby._id }).sort({ nextDueDate: 1, dateGiven: -1 });
  res.render("baby-detail", { title: baby.fullName, baby, vaccines, notice: String(req.query.notice || "").slice(0, 250) });
});
app.post("/babies/:id/vaccines", auth, roles("Administrator", "Healthcare Worker"), async (req, res) => {
  const baby = await Baby.findById(req.params.id); if (!baby) return res.sendStatus(404);
  try {
    const { vaccineName, dose, dateGiven, nextDueDate, status, administeredBy, notes } = req.body;
    if (!vaccineName?.trim()) throw new Error("Vaccine name is required.");
    const given = validDate(dateGiven), due = validDate(nextDueDate);
    if ((dateGiven && !given) || (nextDueDate && !due)) throw new Error("Please enter valid dates.");
    const vaccine = await Vaccine.create({ baby: baby._id, vaccineName, dose, dateGiven: given, nextDueDate: due, status, administeredBy, notes });
    let smsNotice = "";
    if (due) {
      const notification = await notifyOptedInParents(baby, vaccine);
      if (notification.results?.some(r => r.sms?.sent || r.push?.sent)) smsNotice = "Notification sent to one or more opted-in parent device(s).";
      else if (notification.results?.length) smsNotice = "Vaccine record saved, but no notification was sent. Check parent preferences and provider configuration.";
      else smsNotice = "Vaccine record saved. " + (notification.reason || "No notification was sent.");
    }
    res.redirect(`/babies/${baby._id}${smsNotice ? `?notice=${encodeURIComponent(smsNotice)}` : ""}`);
  } catch (e) { res.status(400).send(e.message); }
});
app.get("/my-babies", auth, roles("Parent/Guardian"), async (req, res) => {
  const babies = await Baby.find({ _id: { $in: req.currentUser.babyIds } });
  const month = getMonthRange(req.query.month);
  const monthlyFilter = monthVaccineFilter(month.start, month.end);
  const vaccines = await Vaccine.find({ baby: { $in: req.currentUser.babyIds }, ...monthlyFilter }).populate("baby").sort({ dateGiven: -1, nextDueDate: 1 });
  res.render("my-babies", { title: "My baby's monthly vaccine records", babies, vaccines, month });
});

app.get("/users", auth, roles("Administrator"), async (req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 });
  res.render("users", { title: "User management", users });
});
app.get("/users/new", auth, roles("Administrator"), (req, res) => res.render("user-form", { title: "Create staff account", error: null }));
app.post("/users", auth, roles("Administrator"), async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body;
    if (!["Healthcare Worker", "Administrator"].includes(role)) throw new Error("Select a valid staff role.");
    if (!name?.trim() || !email?.trim() || !password || password.length < 10) throw new Error("All fields are required and password must be at least 10 characters.");
    await User.create({ name, email, phone, role, passwordHash: await bcrypt.hash(password, 12) });
    res.redirect("/users");
  } catch (e) { res.status(400).render("user-form", { title: "Create staff account", error: e.message }); }
});
app.post("/users/:id/toggle", auth, roles("Administrator"), async (req, res) => {
  if (req.params.id === req.currentUser._id.toString()) return res.status(400).send("You cannot deactivate your own account.");
  const u = await User.findById(req.params.id); if (!u) return res.sendStatus(404);
  u.active = !u.active; await u.save(); res.redirect("/users");
});

app.get("/messages", auth, async (req, res) => {
  const filter = { $or: [{ sender: req.currentUser._id }, { recipient: req.currentUser._id }] };
  const messages = await Message.find(filter).populate("sender recipient baby").sort({ createdAt: 1 }).limit(200);
  const users = await User.find({ active: true, _id: { $ne: req.currentUser._id },
    role: req.currentUser.role === "Parent/Guardian" ? "Healthcare Worker" : "Parent/Guardian" }).select("name role");
  res.render("messages", { title: "Messages", messages, users, smsNotice: String(req.query.smsNotice || "").slice(0, 250) });
});
app.post("/messages", auth, async (req, res) => {
  const recipient = await User.findOne({ _id: req.body.recipient, active: true });
  const body = String(req.body.body || "").trim();
  if (!recipient || !body || body.length > 2000) return res.status(400).send("Select a recipient and enter a message up to 2,000 characters.");
  const permitted = (req.currentUser.role === "Parent/Guardian" && recipient.role === "Healthcare Worker") ||
    (["Healthcare Worker", "Administrator"].includes(req.currentUser.role) && recipient.role === "Parent/Guardian");
  if (!permitted) return res.status(403).send("Messaging is limited to parent/guardian and health staff communication.");
  await Message.create({ sender: req.currentUser._id, recipient: recipient._id, body });
  let smsNotice = "";
  if (recipient.role === "Parent/Guardian") {
    const notification = await notifyParent(recipient, "You have a new message from your Barangay Health Center team. Please sign in to your parent account to read it.", "New message from Barangay Sugod Health Center");
    const sent = notification.sms?.sent || notification.push?.sent;
    smsNotice = sent ? "Notification sent to the parent." : "In-app message sent. No SMS or push notification was delivered; check the parent's preferences and device setup.";
  }
  res.redirect(`/messages${smsNotice ? `?smsNotice=${encodeURIComponent(smsNotice)}` : ""}`);
});

app.get("/reports", auth, roles("Administrator", "Healthcare Worker"), async (req, res) => {
  const month = getMonthRange(req.query.month);
  const vaccines = await Vaccine.find(monthVaccineFilter(month.start, month.end)).populate("baby").sort({ dateGiven: -1, nextDueDate: 1 });
  const summary = {
    total: vaccines.length,
    completed: vaccines.filter(v => v.status === "Completed").length,
    scheduled: vaccines.filter(v => v.status === "Scheduled").length,
    missed: vaccines.filter(v => v.status === "Missed").length
  };
  res.render("reports", { title: "Monthly monitoring report", vaccines, month, summary });
});
app.get("/push/config", auth, (req, res) => res.json({ enabled: pushConfigured, publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null, subscribed: Boolean(req.currentUser.pushSubscriptions?.length) }));
app.post("/push/subscribe", auth, roles("Parent/Guardian"), async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: "Web Push is not configured on the server yet." });
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return res.status(400).json({ error: "Invalid push subscription." });
  const subscriptions = req.currentUser.pushSubscriptions || [];
  const exists = subscriptions.some(item => item.endpoint === sub.endpoint);
  if (!exists) req.currentUser.pushSubscriptions.push({ endpoint: sub.endpoint, expirationTime: sub.expirationTime || null, keys: sub.keys });
  req.currentUser.pushOptIn = true;
  await req.currentUser.save();
  res.json({ success: true, message: "Web Push enabled on this device." });
});
app.post("/push/unsubscribe", auth, roles("Parent/Guardian"), async (req, res) => {
  const endpoint = String(req.body.endpoint || "");
  req.currentUser.pushSubscriptions = (req.currentUser.pushSubscriptions || []).filter(item => item.endpoint !== endpoint);
  req.currentUser.pushOptIn = req.currentUser.pushSubscriptions.length > 0;
  await req.currentUser.save();
  res.json({ success: true, message: "Web Push disabled for this device." });
});

app.get("/settings", auth, async (req, res) => res.render("settings", { title: "Notification settings", account: req.currentUser, querySaved: req.query.saved === "1" }));
app.post("/settings", auth, async (req, res) => {
  req.currentUser.phone = String(req.body.phone || "").trim();
  if (req.currentUser.role === "Parent/Guardian") {
    req.currentUser.smsOptIn = req.body.smsOptIn === "on";
    if (req.currentUser.smsOptIn) {
      if (!req.currentUser.phone) return res.status(400).send("Enter a mobile number before opting in to SMS notifications.");
      try { normalizePhilippineNumber(req.currentUser.phone); }
      catch (error) { return res.status(400).send(error.message); }
    }
  }
  await req.currentUser.save(); res.redirect("/settings?saved=1");
});
app.use((req, res) => res.status(404).render("404", { title: "Not found" }));
app.listen(PORT, () => console.log(`Barangay Sugod Baby Vaccine Monitoring System listening on ${PORT}`));

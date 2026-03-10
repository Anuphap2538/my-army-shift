import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import session from "express-session";
import { google } from "googleapis";
import crypto from "crypto";
import cron from "node-cron";

dotenv.config();

const app = express();


function generateDashboardToken() {
  return crypto.randomBytes(32).toString("hex");
}

function buildDashboardUrl(token) {
  const base = process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
  return `${base}/dashboard.html?token=${token}`;
}
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static("public"));

/* =========================
SESSION
========================= */

app.use(
  session({
    secret: process.env.SESSION_SECRET || "army-secret",
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 86400000,
    },
  })
);

/* =========================
DATABASE (TiDB Cloud)
========================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 4000),
  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  },
  waitForConnections: true,
  connectionLimit: 10,
});

/* =========================
UTILS
========================= */
const normalizeGroup = (g) =>
  String(g || "")
    .trim()
    .replace("ศปก.", "ศปก")
    .replace("ศปก．", "ศปก");

const pickBodyOrQuery = (req) => ({
  ...req.query,
  ...(req.body && typeof req.body === "object" ? req.body : {}),
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

app.post("/admin/login", (req, res) => {
  try {
    const { username, password } = req.body || {};

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminUser || !adminPass) {
      return res.status(500).json({ error: "Admin env not set" });
    }

    if (username === adminUser && password === adminPass) {
      req.session.isAdmin = true;
      req.session.adminUsername = username;

      return req.session.save((err) => {
        if (err) {
          console.error("ADMIN SESSION SAVE ERROR:", err);
          return res.status(500).json({ error: "Session save failed" });
        }
        return res.json({ success: true });
      });
    }

    return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  } catch (err) {
    console.error("ADMIN LOGIN ERROR:", err);
    return res.status(500).json({ error: "Login error" });
  }
});

app.get("/admin/check", (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.json({ ok: true, username: req.session.adminUsername || null });
  }
  return res.status(401).json({ error: "Unauthorized" });
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("ADMIN LOGOUT ERROR:", err);
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("connect.sid");
    return res.json({ success: true });
  });
});

/* =========================
TEST DATABASE
========================= */
async function testDB() {
  try {
    const conn = await pool.getConnection();
    console.log("✅ Database Connected");
    conn.release();
  } catch (err) {
    console.error("❌ Database Error:", err.message);
  }
}
testDB();

app.get("/test-db", async (req, res) => {
  try {
    const [r] = await pool.query("SELECT 1 as ok");
    res.json({ ok: r?.[0]?.ok === 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
GOOGLE OAUTH
========================= */
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/login-redirect`
  : "http://localhost:3000/login-redirect";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

/* =========================
GOOGLE LOGIN
========================= */
app.get("/google/auth", async (req, res) => {
  try {
    const userId = req.query.user_id;

    if (!userId) {
      return res.status(400).send("ไม่พบ user_id");
    }

    req.session.pendingUserId = userId;

    req.session.save((err) => {
      if (err) {
        console.error("SESSION SAVE ERROR:", err);
        return res.status(500).send("Session Error");
      }

      const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/userinfo.email",
          "openid",
        ],
      });

      res.redirect(url);
    });
  } catch (err) {
    console.error("GOOGLE AUTH ERROR:", err);
    res.status(500).send("Google Auth Error");
  }
});

app.get("/login-redirect", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("❌ Invalid Login Request");
    }

    const pendingUserId = req.session.pendingUserId;
    if (!pendingUserId) {
      return res.status(400).send("❌ ไม่พบข้อมูลผู้ใช้ที่เลือก");
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;
    const dashboardToken = generateDashboardToken();

    const [rows] = await pool.execute(
      "SELECT id, rank_name FROM users WHERE id=?",
      [pendingUserId]
    );

    if (rows.length === 0) {
      return res.status(404).send("❌ ไม่พบรายชื่อผู้ใช้ในระบบ");
    }

    await pool.execute(
      `UPDATE users
       SET email=?, google_token=?, dashboard_token=?
       WHERE id=?`,
      [email, JSON.stringify(tokens), dashboardToken, pendingUserId]
    );

        // 🚀 Sync เวรของคนนี้เข้า Google Calendar ทันทีหลัง login สำเร็จ
    const [myShifts] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email
       FROM shift_assignments s
       JOIN users u ON s.user_id = u.id
       WHERE s.user_id = ?`,
      [pendingUserId]
    );

    for (const shift of myShifts) {
      try {
        const auth = buildAuthFromToken(JSON.stringify(tokens));

        // เอาเวรของ "วันเดียวกัน" มาคำนวณ description ให้ถูก
        const dateKey =
          typeof shift.shift_date === "string"
            ? shift.shift_date.split("T")[0]
            : new Date(shift.shift_date).toISOString().split("T")[0];

        const [dayShifts] = await pool.execute(
          `SELECT s.*, u.rank_name, u.email
           FROM shift_assignments s
           JOIN users u ON s.user_id = u.id
           WHERE DATE(s.shift_date) = ?`,
          [dateKey]
        );

        await sendToGoogleCalendar(auth, shift, dayShifts);
      } catch (e) {
        console.log("AUTO SYNC ERROR:", e.message);
      }
    }

    req.session.userId = rows[0].id;
    req.session.userName = rows[0].rank_name;
    req.session.userEmail = email;
    req.session.pendingUserId = null;

    res.redirect(process.env.DASHBOARD_URL || "/dashboard.html");
  } catch (err) {
    console.error("LOGIN REDIRECT ERROR:", err);
    res.status(500).send("Login Error");
  }
});

/* =========================
GOOGLE CALENDAR HELPERS
========================= */
function buildAuthFromToken(tokenJson) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  auth.setCredentials(JSON.parse(tokenJson));
  return auth;
}

async function getColonelUser() {
  const [rows] = await pool.execute(
    `SELECT id, rank_name, email, google_token, dashboard_token
     FROM users
     WHERE is_colonel = 1
     LIMIT 1`
  );

  if (rows.length === 0) {
    throw new Error("ยังไม่ได้ตั้งผู้พันในระบบ");
  }

  if (!rows[0].google_token) {
    throw new Error("ผู้พันยังไม่ได้เชื่อม Google");
  }

  return rows[0];
}


async function sendToGoogleCalendar(auth, shift, allShifts) {
  const calendar = google.calendar({ version: "v3", auth });

  const kp = allShifts.filter((s) => normalizeGroup(s.group_name) === "กองพัน").length;
const spk = allShifts.filter((s) => normalizeGroup(s.group_name) === "ศปก").length;

const shiftGroup = normalizeGroup(shift.group_name);
const shiftRole = String(shift.role_type || "").trim();

// ✅ หานายทหารเวร "เฉพาะกลุ่มเดียวกัน"
const supervisor = allShifts.find((s) => {
  const sameGroup = normalizeGroup(s.group_name) === shiftGroup;
  const sameSupervisorRole = String(s.role_type || "").includes("นายทหารเวร");
  return sameGroup && sameSupervisorRole;
});

let summary;
let description;
let location = "";

  // ===== นายทหารเวร =====
if (shiftRole.includes("นายทหารเวร")) {
  if (shiftGroup === "กองพัน") {
    summary = `🛡️ นายทหารเวรกองพัน`;
    description = `ยอดกำลังพลกองพันวันนี้ ${kp} นาย`;
    location = "กองพัน";
  } else if (shiftGroup === "ศปก") {
    summary = `🛡️ นายทหารเวร ศปก.`;
    description = `ยอดกำลังพล ศปก. วันนี้ ${spk} นาย`;
    location = "ศปก.";
  } else {
    summary = `🛡️ ${shiftRole}`;
    description = `ยอดกำลังพลวันนี้ ${allShifts.length} นาย`;
    location = shift.group_name || "";
  }
}

// ===== เวรวิทยุ =====
else if (shiftRole.includes("เวรวิทยุ")) {
  const turnText = shift.shift_turn ? ` (ผลัด ${shift.shift_turn})` : "";
  summary = `💂 เวรวิทยุ${turnText}`;
  description = `วันนี้เข้าเวร\n👤 นายทหารเวร${shiftGroup ? " " + shift.group_name : ""}: ${
    supervisor ? supervisor.rank_name : "ยังไม่ระบุ"
  }`;
  location = shift.group_name || "ศปก.";
}

// ===== เวรอื่น ๆ =====
else {
  summary = `💂 ${shiftRole}`;
  description = `วันนี้เข้าเวร\n👤 นายทหารเวร${shiftGroup ? " " + shift.group_name : ""}: ${
    supervisor ? supervisor.rank_name : "ยังไม่ระบุ"
  }`;
  location = shift.group_name || "";
}

  const dateOnly =
    typeof shift.shift_date === "string"
      ? shift.shift_date.split("T")[0]
      : new Date(shift.shift_date).toISOString().split("T")[0];

  let dashboardLine = "";
  try {
    const targetEmail = shift.email || null;

    if (targetEmail) {
      const [rows] = await pool.execute(
        "SELECT dashboard_token FROM users WHERE email=?",
        [targetEmail]
      );

      if (rows.length > 0 && rows[0].dashboard_token) {
        dashboardLine = `\n\n📱 Dashboard ส่วนตัว:\n${buildDashboardUrl(rows[0].dashboard_token)}`;
      }
    }
  } catch (e) {
    console.error("DASHBOARD LINK ERROR:", e.message);
  }

  const event = {
  summary,
  location,
  description: `[ARMY_SHIFT]\n${description}${dashboardLine}`,
  start: { dateTime: `${dateOnly}T08:00:00`, timeZone: "Asia/Bangkok" },
  end: { dateTime: `${dateOnly}T10:00:00`, timeZone: "Asia/Bangkok" },
  reminders: {
    useDefault: false,
    overrides: [
      { method: "popup", minutes: 60 }, // 07:00 เตือนก่อนเข้าเวร
      { method: "popup", minutes: 0 }   // 08:00 ตอนเริ่มเวร
    ],
  },
};

  // 🔎 ค้นหา event เก่าที่ระบบนี้เคยสร้างไว้ในวันเดียวกัน
  const existing = await calendar.events.list({
    calendarId: "primary",
    timeMin: `${dateOnly}T00:00:00+07:00`,
    timeMax: `${dateOnly}T23:59:59+07:00`,
    q: "ARMY_SHIFT",
  });

  // 🗑 ลบเฉพาะ event เก่าที่เป็นของระบบเรา และ role ตรงกัน
  if (existing.data.items && existing.data.items.length > 0) {
    for (const ev of existing.data.items) {
      const evDesc = ev.description || "";
      const evSummary = ev.summary || "";

      const sameSystem = evDesc.includes("[ARMY_SHIFT]");
      const sameRole = evSummary.includes(String(shift.role_type || ""));

      if (sameSystem && sameRole) {
        try {
          await calendar.events.delete({
            calendarId: "primary",
            eventId: ev.id,
          });
        } catch (err) {
          console.log("Delete old event error:", err.message);
        }
      }
    }
  }

  // ➕ สร้าง event ใหม่
  return calendar.events.insert({
    calendarId: "primary",
    resource: event,
  });
}

async function sendSummaryToColonelCalendar(targetDate, allShifts) {
  const colonel = await getColonelUser();
  const auth = buildAuthFromToken(colonel.google_token);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = "primary";
  const dashboardUrl = colonel.dashboard_token
  ? buildDashboardUrl(colonel.dashboard_token)
  : "";

  const dateOnly =
    typeof targetDate === "string"
      ? targetDate.slice(0, 10)
      : new Date(targetDate).toISOString().split("T")[0];

  const kpShifts = allShifts.filter(
    (s) => normalizeGroup(s.group_name) === "กองพัน"
  );
  const spkShifts = allShifts.filter(
    (s) => normalizeGroup(s.group_name) === "ศปก"
  );

  const kpSupervisor = kpShifts.find((s) =>
    String(s.role_type || "").includes("นายทหารเวร")
  );
  const spkSupervisor = spkShifts.find((s) =>
    String(s.role_type || "").includes("นายทหารเวร")
  );

  const summary = `📋 สรุปเวรประจำวัน (${dateOnly})`;

  const description =
  `[ARMY_SHIFT_COLONEL]\n` +
  `กองพัน: ${kpShifts.length} นาย\n` +
  `นายทหารเวรกองพัน: ${kpSupervisor ? kpSupervisor.rank_name : "ยังไม่ระบุ"}\n\n` +
  `ศปก.: ${spkShifts.length} นาย\n` +
  `นายทหารเวร ศปก.: ${spkSupervisor ? spkSupervisor.rank_name : "ยังไม่ระบุ"}` +
  (dashboardUrl ? `\n\n📱 Dashboard ผู้พัน:\n${dashboardUrl}` : "");

  const event = {
    summary,
    description,
    start: { dateTime: `${dateOnly}T07:00:00`, timeZone: "Asia/Bangkok" },
    end: { dateTime: `${dateOnly}T07:30:00`, timeZone: "Asia/Bangkok" },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 0 }],
    },
  };

  // ลบ event สรุปเดิมของวันนั้นก่อน กันซ้ำ
  const existing = await calendar.events.list({
    calendarId,
    timeMin: `${dateOnly}T00:00:00+07:00`,
    timeMax: `${dateOnly}T23:59:59+07:00`,
    q: "ARMY_SHIFT_COLONEL",
  });

  if (existing.data.items && existing.data.items.length > 0) {
    for (const ev of existing.data.items) {
      const evDesc = ev.description || "";
      if (evDesc.includes("[ARMY_SHIFT_COLONEL]")) {
        try {
          await calendar.events.delete({
            calendarId,
            eventId: ev.id,
          });
        } catch (err) {
          console.log("Delete old colonel event error:", err.message);
        }
      }
    }
  }

  return calendar.events.insert({
    calendarId,
    resource: event,
  });
}

/* =========================
API: USERS
========================= */
app.get("/get-users", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, rank_name, role, email,
      (google_token IS NOT NULL) AS is_linked
      FROM users
      ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET USERS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/debug/routes", (req, res) => {
  res.json({
    ok: true,
    hasGetUsers: true,
    time: new Date().toISOString(),
  });
});

app.get("/debug/users-count", async (req, res) => {
  try {
    const [r] = await pool.execute("SELECT COUNT(*) as c FROM users");
    res.json({ count: r[0].c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
API: SHIFTS LIST
========================= */
app.get("/get-shifts", async (req, res) => {
  try {
    const { month, year } = req.query;
    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email
       FROM shift_assignments s
       JOIN users u ON s.user_id=u.id
       WHERE MONTH(s.shift_date)=? AND YEAR(s.shift_date)=?
       ORDER BY s.shift_date`,
      [month, year]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/* =========================
API: ASSIGN SHIFT
- รองรับ shift_turn / note ถ้ามี column
- ถ้า table ไม่มี column เหล่านี้ จะ fallback ไป insert แบบเก่า
========================= */
app.post("/assign-shift", async (req, res) => {
  try {
    const {
      user_id,
      shift_date,
      role_type,
      group_name,
      shift_turn = null,
      note = null,
    } = req.body;

    if (!user_id || !shift_date) return res.status(400).send("ข้อมูลไม่ครบ");

    const groupNorm = normalizeGroup(group_name);

    const [existing] = await pool.execute(
      "SELECT id FROM shift_assignments WHERE user_id=? AND shift_date=?",
      [user_id, shift_date]
    );
    if (existing.length > 0) return res.status(400).send("มีเวรแล้ว");

    // ลอง insert แบบ full ก่อน
    try {
      await pool.execute(
        `INSERT INTO shift_assignments
         (user_id, shift_date, role_type, group_name, shift_turn, note)
         VALUES (?,?,?,?,?,?)`,
        [user_id, shift_date, role_type, groupNorm, shift_turn, note]
      );
    } catch (e) {
      // fallback สำหรับ schema เก่า
      await pool.execute(
        `INSERT INTO shift_assignments
         (user_id, shift_date, role_type, group_name)
         VALUES (?,?,?,?)`,
        [user_id, shift_date, role_type, groupNorm]
      );
    }

    // ถ้าคนนี้ link google แล้ว -> ส่งเข้า calendar ทันที (best effort)
    const [user] = await pool.execute(
      "SELECT google_token, email, rank_name FROM users WHERE id=?",
      [user_id]
    );

    if (user.length > 0 && user[0].google_token) {
      try {
        const auth = buildAuthFromToken(user[0].google_token);
        const [dayShifts] = await pool.execute(
          `SELECT s.*, u.rank_name, u.email
           FROM shift_assignments s
           JOIN users u ON s.user_id=u.id
           WHERE s.shift_date=?`,
          [shift_date]
        );
        await sendToGoogleCalendar(
          auth,
          {
            shift_date,
            role_type,
            group_name: groupNorm,
            email: user[0].email,
            rank_name: user[0].rank_name,
          },
          dayShifts
        );
      } catch (tokenErr) {
        console.error("❌ Token/Calendar Error:", tokenErr.message);
      }
    }

    res.send("ok");
  } catch (err) {
    console.error("ASSIGN ERROR:", err);
    res.status(500).send(err.message);
  }
});

/* =========================
API: DELETE SHIFT
========================= */
app.delete("/delete-shift/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("DELETE FROM shift_assignments WHERE id=?", [id]);
    res.send("ok");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/* =========================
API: REPORT (calendar report by group)
========================= */
app.get("/get-report-calendar", async (req, res) => {
  try {
    const { month, year, group } = req.query;

    const g = String(group || "").trim();

    // รองรับทั้ง "ศปก" และ "ศปก."
    const groupList =
      g === "ศปก" || g === "ศปก."
        ? ["ศปก", "ศปก."]
        : [g];

    const placeholders = groupList.map(() => "?").join(",");

    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name
       FROM shift_assignments s
       JOIN users u ON s.user_id=u.id
       WHERE MONTH(s.shift_date)=?
         AND YEAR(s.shift_date)=?
         AND TRIM(s.group_name) IN (${placeholders})`,
      [month, year, ...groupList]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/* =========================
SYNC: BY SELECTED DATE
========================= */
app.post("/sync-date", async (req, res) => {
  try {
    const { date } = pickBodyOrQuery(req); // รองรับทั้ง body/query
    if (!date) return res.status(400).json({ error: "missing date (YYYY-MM-DD)" });

    // บังคับรูปแบบวันที่ให้ชัวร์
    const dateStr = String(date).slice(0, 10); // YYYY-MM-DD

    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email, u.google_token
       FROM shift_assignments s
       JOIN users u ON s.user_id=u.id
       WHERE DATE(s.shift_date)=?`,
      [dateStr]
    );

    let success = 0;
    let skip = 0;

    for (const shift of rows) {
      if (!shift.google_token) {
        skip++;
        continue;
      }
      try {
        const auth = buildAuthFromToken(shift.google_token);
        await sendToGoogleCalendar(auth, shift, rows);
        success++;
      } catch (err) {
        console.log("SYNC DATE ERR:", err.message);
        skip++;
      }
    }

    res.json({
      success: true,
      message: `ซิงค์เวรวันที่ ${dateStr} สำเร็จ ${success} นาย / ข้าม ${skip} นาย`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
SYNC: EXISTING SHIFTS (BY MONTH/YEAR/GROUP)
- รองรับส่งทั้ง query หรือ body
========================= */
app.post("/sync-existing-shifts", async (req, res) => {
  const { month, year, group } = pickBodyOrQuery(req);
  const g = normalizeGroup(group);

  console.log(`🚀 Sync เดือน ${month}/${year} กลุ่ม ${g}`);

  try {
    const [allShifts] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email, u.google_token
       FROM shift_assignments s
       JOIN users u ON s.user_id=u.id
       WHERE MONTH(s.shift_date)=? AND YEAR(s.shift_date)=?`,
      [month, year]
    );

    const target = allShifts.filter(
      (s) => normalizeGroup(s.group_name) === g
    );

    let success = 0;
    let skip = 0;

    for (const shift of target) {
      if (!shift.google_token) {
        skip++;
        continue;
      }
      try {
        const auth = buildAuthFromToken(shift.google_token);

        // dayShifts สำหรับ description
        const dateKey =
          typeof shift.shift_date === "string"
            ? shift.shift_date
            : new Date(shift.shift_date).toISOString().split("T")[0];

        const dayShifts = allShifts.filter((s) => {
          const k =
            typeof s.shift_date === "string"
              ? s.shift_date
              : new Date(s.shift_date).toISOString().split("T")[0];
          return k === dateKey;
        });

        await sendToGoogleCalendar(auth, shift, dayShifts);
        success++;
      } catch (err) {
        console.log(`❌ Sync ผิดพลาด ${shift.rank_name}:`, err.message);
        skip++;
      }
    }

    res.json({
      success: true,
      message: `Sync สำเร็จ ${success} นาย / ข้าม ${skip} นาย`,
    });
  } catch (err) {
    console.error("SYNC ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/sync-colonel-daily", async (req, res) => {
  try {
    const dateStr = date
  ? String(date).slice(0, 10)
  : new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Bangkok",
    });

    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email
       FROM shift_assignments s
       JOIN users u ON s.user_id = u.id
       WHERE DATE(s.shift_date)=?`,
      [dateStr]
    );

    await sendSummaryToColonelCalendar(dateStr, rows);

    res.json({
      success: true,
      message: `ซิงค์แจ้งเตือนผู้พันวันที่ ${dateStr} สำเร็จ`,
    });
  } catch (err) {
    console.error("SYNC COLONEL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
SYSTEM: CLEAR
- รองรับทั้ง DELETE และ GET เพื่อกันหน้าเก่าเรียกผิด method
========================= */
async function clearAllShiftsImpl(res) {
  try {
    await pool.execute("DELETE FROM shift_assignments");
    res.send("ok");
  } catch (err) {
    res.status(500).send(err.message);
  }
}

async function clearAllUsersImpl(res) {
  try {
    await pool.execute("DELETE FROM shift_assignments");
    await pool.execute("DELETE FROM users");
    res.send("ok");
  } catch (err) {
    res.status(500).send(err.message);
  }
}

app.delete("/clear-all-shifts", async (req, res) => clearAllShiftsImpl(res));
app.get("/clear-all-shifts", async (req, res) => clearAllShiftsImpl(res)); // backward compat

app.delete("/clear-all-users", async (req, res) => clearAllUsersImpl(res));
app.get("/clear-all-users", async (req, res) => clearAllUsersImpl(res)); // backward compat

/* =========================
API: MY DUTY (all people on dates that I have duty)
========================= */
app.get("/get-my-duty", async (req, res) => {
  try {
    let userId = req.session.userId;
    let isColonel = false;
    const token = req.query.token;

    if (token) {
      const [userRows] = await pool.execute(
        "SELECT id, is_colonel FROM users WHERE dashboard_token=?",
        [token]
      );

      if (userRows.length === 0) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      userId = userRows[0].id;
      isColonel = Number(userRows[0].is_colonel || 0) === 1;
    } else if (userId) {
      const [me] = await pool.execute(
        "SELECT is_colonel FROM users WHERE id=?",
        [userId]
      );
      if (me.length > 0) {
        isColonel = Number(me[0].is_colonel || 0) === 1;
      }
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ===== ผู้พัน: ดูเฉพาะวันรายงาน และเฉพาะ 2 กลุ่ม =====
    if (isColonel) {
      const [rows] = await pool.execute(
        `SELECT s.*, u.rank_name
         FROM shift_assignments s
         JOIN users u ON s.user_id = u.id
         WHERE DATE(s.shift_date) IN (
           SELECT DISTINCT DATE(shift_date)
           FROM shift_assignments
         )
         AND TRIM(s.group_name) IN ('กองพัน', 'ศปก', 'ศปก.')
         ORDER BY s.shift_date, s.group_name, s.role_type`
      );

      return res.json({
        mode: "colonel",
        rows
      });
    }

    // ===== คนทั่วไป: ใช้ logic เดิม =====
    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name
       FROM shift_assignments s
       JOIN users u ON s.user_id = u.id
       WHERE s.shift_date IN (
         SELECT shift_date
         FROM shift_assignments
         WHERE user_id = ?
       )
       ORDER BY s.shift_date, s.role_type`,
      [userId]
    );

    return res.json({
      mode: "user",
      rows
    });
  } catch (err) {
    console.error("GET MY DUTY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
PROFILE + HEALTH
========================= */
app.get("/api/my-profile", async (req, res) => {
  try {
    const token = req.query.token;

    if (token) {
      const [rows] = await pool.execute(
        "SELECT id, rank_name, email FROM users WHERE dashboard_token=?",
        [token]
      );

      if (rows.length === 0) {
        return res.status(401).send("Unauthorized");
      }

      return res.json({
        id: rows[0].id,
        name: rows[0].rank_name,
        email: rows[0].email,
      });
    }

    if (!req.session.userId) {
      return res.status(401).send("Unauthorized");
    }

    return res.json({
      id: req.session.userId,
      name: req.session.userName,
      email: req.session.userEmail,
    });
  } catch (err) {
    console.error("MY PROFILE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.send("OK"));

/* =========================
SAFETY: LOG UNHANDLED
========================= */
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

app.get("/debug/user/:id", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, rank_name, email, google_token, dashboard_token FROM users WHERE id=?",
      [req.params.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cron.schedule("0 6 * * *", async () => {
  try {
    const today = new Date().toLocaleDateString("en-CA", {
  timeZone: "Asia/Bangkok",
});

    const [rows] = await pool.execute(
      `SELECT s.*, u.rank_name, u.email
       FROM shift_assignments s
       JOIN users u ON s.user_id = u.id
       WHERE DATE(s.shift_date)=?`,
      [today]
    );

    await sendSummaryToColonelCalendar(today, rows);
    console.log("✅ Colonel daily sync success:", today);
  } catch (err) {
    console.error("❌ Colonel cron sync error:", err.message);
  }
}, {
  timezone: "Asia/Bangkok"
});

/* =========================
START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});
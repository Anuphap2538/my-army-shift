import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import session from "express-session";
import { google } from "googleapis";

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.static("public"));

/* =========================
SESSION
========================= */

app.use(
  session({
    secret: process.env.SESSION_SECRET || "army-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 86400000,
    },
  })
);

/* =========================
DATABASE POOL
========================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  },
  waitForConnections: true,
  connectionLimit: 10,
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

/* =========================
GOOGLE OAUTH
========================= */

const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
  ? `${process.env.RENDER_EXTERNAL_URL}/login-redirect` 
  : 'http://localhost:3000/login-redirect';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

/* =========================
GOOGLE LOGIN
========================= */

app.get("/google/auth", (req, res) => {
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

app.get("/login-redirect", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.send("❌ Invalid Login Request");
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    const [rows] = await pool.execute(
      "SELECT id,rank_name FROM users WHERE email=?",
      [email]
    );

    if (rows.length === 0) {
      return res.send("❌ ไม่พบ email ในระบบ");
    }

    await pool.execute(
      "UPDATE users SET google_token=? WHERE email=?",
      [JSON.stringify(tokens), email]
    );

    req.session.userId = rows[0].id;
    req.session.userName = rows[0].rank_name;
    req.session.userEmail = email;

    res.redirect("/dashboard.html");
  } catch (err) {
    console.error("Login Error:", err);
    res.send("Login Error");
  }
});

/* =========================
SEND GOOGLE CALENDAR
========================= */

async function sendToGoogleCalendar(auth, shift, allShifts) {
  const calendar = google.calendar({ version: "v3", auth });

  const kp = allShifts.filter((s) => (s.group_name || "").trim() === "กองพัน").length;
  const spk = allShifts.filter((s) => (s.group_name || "").trim() === "ศปก").length;

  const supervisor = allShifts.find((s) =>
    (s.role_type || "").includes("นายทหารเวร")
  );

  let summary;
  let description;

  if ((shift.role_type || "").includes("นายทหารเวร")) {
    summary = `🛡️ เวร: ${shift.role_type}`;
    description = `📊 ยอดเวรวันนี้: กองพัน ${kp} นาย / ศปก ${spk} นาย`;
  } else {
    summary = `💂 เวร: ${shift.role_type}`;
    description = `👤 นายทหารเวร: ${
      supervisor ? supervisor.rank_name : "ยังไม่ระบุ"
    }`;
  }

  const dateOnly = new Date(shift.shift_date).toISOString().split("T")[0];

  const event = {
    summary,
    description,
    start: {
      dateTime: `${dateOnly}T08:00:00`,
      timeZone: "Asia/Bangkok",
    },
    end: {
      dateTime: `${dateOnly}T09:00:00`,
      timeZone: "Asia/Bangkok",
    },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    },
  };

  return calendar.events.insert({
    calendarId: "primary",
    resource: event,
  });
}

/* =========================
ASSIGN SHIFT
========================= */

app.post("/assign-shift", async (req, res) => {
  try {
    const { user_id, shift_date, role_type, group_name } = req.body;

    if (!user_id || !shift_date) {
      return res.status(400).send("ข้อมูลไม่ครบ");
    }

    const [existing] = await pool.execute(
      "SELECT id FROM shift_assignments WHERE user_id=? AND shift_date=?",
      [user_id, shift_date]
    );

    if (existing.length > 0) {
      return res.status(400).send("มีเวรแล้ว");
    }

    await pool.execute(
      "INSERT INTO shift_assignments (user_id,shift_date,role_type,group_name) VALUES (?,?,?,?)",
      [user_id, shift_date, role_type, group_name]
    );

    const [user] = await pool.execute(
      "SELECT google_token,email,rank_name FROM users WHERE id=?",
      [user_id]
    );

    if (user.length > 0 && user[0].google_token) {
      try {
        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          REDIRECT_URI
        );

        auth.setCredentials(JSON.parse(user[0].google_token));

        const [dayShifts] = await pool.execute(
          `SELECT s.*,u.rank_name,u.email 
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
            group_name,
            email: user[0].email,
            rank_name: user[0].rank_name,
          },
          dayShifts
        );
      } catch (tokenErr) {
        console.error("❌ Token Error for individual assign:", tokenErr.message);
      }
    }

    res.send("ok");
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.post("/sync-today", async (req, res) => {

  try {

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];

    const [rows] = await pool.execute(
      `SELECT s.*,u.rank_name,u.email,u.google_token
      FROM shift_assignments s
      JOIN users u ON s.user_id=u.id
      WHERE s.shift_date=?`,
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

        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          REDIRECT_URI
        );

        auth.setCredentials(JSON.parse(shift.google_token));

        await sendToGoogleCalendar(auth, shift, rows);

        success++;

      } catch (err) {

        console.log(err.message);
        skip++;

      }

    }

    res.json({
      message: `ซิงค์เวรวันนี้สำเร็จ ${success} นาย / ข้าม ${skip} นาย`
    });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* =========================
GET USERS & SHIFTS
========================= */

app.get("/get-report-calendar", async (req, res) => {
  try {

    const { month, year, group } = req.query;

    const [rows] = await pool.execute(
      `SELECT s.*,u.rank_name
       FROM shift_assignments s
       JOIN users u ON s.user_id=u.id
       WHERE MONTH(s.shift_date)=?
       AND YEAR(s.shift_date)=?
       AND TRIM(s.group_name)=TRIM(?)`,
      [month, year, group]
    );

    res.json(rows);

  } catch (err) {

    res.status(500).send(err.message);

  }
});

app.delete("/delete-shift/:id", async (req, res) => {
  try {

    const { id } = req.params;

    await pool.execute(
      "DELETE FROM shift_assignments WHERE id=?",
      [id]
    );

    res.send("ok");

  } catch (err) {

    res.status(500).send(err.message);

  }
});

app.get("/get-users", async (req, res) => {
  try {

    const [rows] = await pool.execute(
      "SELECT id, rank_name, role FROM users ORDER BY id"
    );

    res.json(rows);

  } catch (err) {

    console.error("❌ GET USERS ERROR:", err);
    res.status(500).json({
      error: err.message
    });

  }
});

app.get("/get-shifts", async (req, res) => {
  try {
    const { month, year } = req.query;
    const [rows] = await pool.execute(
      `SELECT s.*,u.rank_name FROM shift_assignments s JOIN users u ON s.user_id=u.id WHERE MONTH(s.shift_date)=? AND YEAR(s.shift_date)=? ORDER BY s.shift_date`,
      [month, year]
    );
    res.json(rows);
  } catch (err) { res.status(500).send(err.message); }
});

/* =========================
SYNC EXISTING SHIFTS (ตัวแก้ใหม่: ปลอดภัย & แม่นยำ)
========================= */

app.post("/sync-existing-shifts", async (req, res) => {
  const { month, year, group } = req.query;
  console.log(`🚀 เริ่ม Sync เดือน ${month}/${year} กลุ่ม ${group}`);

  try {
    const [allShifts] = await pool.execute(
      `SELECT s.*,u.rank_name,u.email,u.google_token
      FROM shift_assignments s
      JOIN users u ON s.user_id=u.id
      WHERE MONTH(s.shift_date)=?
      AND YEAR(s.shift_date)=?`,
      [month, year]
    );

    const targetShifts = allShifts.filter(
      (s) => (s.group_name || "").trim() === (group || "").trim()
    );

    console.log(`พบเป้าหมายที่ต้อง Sync ${targetShifts.length} รายการ`);

    let success = 0;
    let skip = 0;

    // เปลี่ยนมาใช้ for...of เพื่อความแม่นยำและกันโดน Google Rate Limit
    for (const shift of targetShifts) {
      if (!shift.google_token) {
        console.log(`⚠️ ข้าม ${shift.rank_name}: ไม่มี Token`);
        skip++;
        continue;
      }

      try {
        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          REDIRECT_URI
        );

        auth.setCredentials(JSON.parse(shift.google_token));

        const shiftDateObj = new Date(shift.shift_date);
        const dayShifts = allShifts.filter(
          (s) => new Date(s.shift_date).toDateString() === shiftDateObj.toDateString()
        );

        await sendToGoogleCalendar(auth, shift, dayShifts);
        success++;
        console.log(`✅ Sync สำเร็จ: ${shift.rank_name}`);
      } catch (err) {
        console.log(`❌ ผิดพลาดที่ ${shift.rank_name}:`, err.message);
        skip++;
      }
    }

    res.json({
      success: true,
      message: `Sync สำเร็จ ${success} นาย / ข้าม ${skip} นาย`,
    });

  } catch (err) {
    console.error("SYNC ERROR", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
SYSTEM ROUTES (CLEAR/PROFILE/HEALTH)
========================= */

app.delete("/clear-all-users", async (req, res) => {
  try {
    await pool.execute("DELETE FROM shift_assignments");
    await pool.execute("DELETE FROM users");
    res.send("ok");
  } catch (err) { res.status(500).send(err.message); }
});

app.delete("/clear-all-shifts", async (req, res) => {
  try {
    await pool.execute("DELETE FROM shift_assignments");
    res.send("ok");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/api/my-profile", (req, res) => {
  if (!req.session.userId) return res.status(401).send("Unauthorized");
  res.json({ id: req.session.userId, name: req.session.userName, email: req.session.userEmail });
});

app.get("/health", (req, res) => { res.send("OK"); });

/* =========================
START SERVER
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});
import express from 'express';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import { google } from 'googleapis';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. ตั้งค่า Session
app.use(session({
    secret: 'army-duty-secret-key',
    resave: false,
    saveUninitialized: true
}));

// 2. ตั้งค่า Database
const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    user: '2FUpHhTtXJDwkTV.root', // 👈 เช็คดีๆ นะว่าก๊อปมาครบไหม
    password: 'UikEOsL5EdIDomNr', // 👈 รหัสผ่าน TiDB ของเพื่อน
    database: 'shift_db',
    port: 4000,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
};

// ฟังก์ชันสำหรับดึง Connection (เพิ่มเข้าไปให้แล้ว)
async function getConnection() {
    return await mysql.createConnection(dbConfig);
}

// ฟังก์ชันทดสอบการเชื่อมต่อ
async function testConnection() {
    try {
        const connection = await getConnection();
        console.log("✅ เชื่อมต่อฐานข้อมูล Cloud สำเร็จแล้วเพื่อน!");
        await connection.end();
    } catch (err) {
        console.error("❌ เชื่อมต่อไม่ได้เพราะ: ", err.message);
    }
}
testConnection();

// 3. ตั้งค่า Google OAuth 
// ✅ แก้ใหม่ให้ตรงกับ Google Console เป๊ะๆ
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `https://my-army-shift.onrender.com/login-redirect` 
    : 'http://localhost:3000/google/callback';

const oauth2Client = new google.auth.OAuth2(
    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
    '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',
    REDIRECT_URI
);

// --- 🌟 ฟังก์ชันหลักสำหรับส่งเข้า Calendar 🌟 ---
async function addDutyToCalendar(summary, date, tokenJson) {
    if (!tokenJson) return false;
    try {
        const userAuth = new google.auth.OAuth2(
            '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
            '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',
            REDIRECT_URI
        );
        userAuth.setCredentials(JSON.parse(tokenJson));
        const calendar = google.calendar({ version: 'v3', auth: userAuth });
        
        const d = new Date(date);
        const dateString = d.toISOString().split('T')[0];

        await calendar.events.insert({
            calendarId: 'primary',
            resource: {
                summary: `📅 เวร: ${summary}`,
                description: 'ระบบจัดเวร กองพันทหารอากาศโยธิน',
                start: { date: dateString, timeZone: 'Asia/Bangkok' },
                end: { date: dateString, timeZone: 'Asia/Bangkok' },
            },
        });
        return true;
    } catch (error) {
        console.error('❌ Google Insert Error:', error.message);
        return false;
    }
}

// ฟังก์ชันสร้าง Event แบบฉลาด (Smart Notification)
async function createSmartCalendarEvent(auth, shiftData, allShiftsOfDay) {
    const calendar = google.calendar({ version: 'v3', auth });
    
    // 1. คัดกรองข้อมูลเบื้องต้น
    const kpCount = allShiftsOfDay.filter(s => s.group === 'กองพัน').length;
    const spkCount = allShiftsOfDay.filter(s => s.group === 'ศปก').length;
    const supervisor = allShiftsOfDay.find(s => s.role_type.includes('นายทหารเวร'));

    let description = "";
    let summary = "";

    // 2. Logic แยกข้อความตามหน้าที่ (Role-based Content)
    if (shiftData.role_type.includes('นายทหารเวร')) {
        summary = `🛡️ วันของคุณ: ${shiftData.role_type}`;
        description = `📊 ยอดเวรวันนี้: กองพัน ${kpCount} นาย / ศปก. ${spkCount} นาย\n\n🔗 ดูรายชื่อทั้งหมด: ${process.env.DASHBOARD_URL}`;
    } else {
        summary = `💂 เวร: ${shiftData.role_type}`;
        description = `👤 นายทหารเวรวันนี้: ${supervisor ? supervisor.rank_name : 'ยังไม่ได้ระบุ'}\n\n🔗 ดูคู่เวรและรายละเอียด: ${process.env.DASHBOARD_URL}`;
    }

    // 3. ตั้งค่ากิจกรรม (Event) และการเตือน 07:00 น.
    const event = {
        summary: summary,
        description: description,
        location: 'หน่วยฝึก/ศปก.',
        start: {
            dateTime: `${shiftData.shift_date}T08:00:00`, // เริ่ม 8 โมงเพื่อล็อควันที่
            timeZone: 'Asia/Bangkok',
        },
        end: {
            dateTime: `${shiftData.shift_date}T08:15:00`,
            timeZone: 'Asia/Bangkok',
        },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 60 } // 🔥 เตือนล่วงหน้า 60 นาที = 07:00 น. พอดีเป๊ะ!
            ]
        }
    };

    // ส่งคำสั่งสร้าง Event ไปที่ Google
    return calendar.events.insert({
        calendarId: shiftData.email, // ส่งเข้าเมลเจ้าตัว
        resource: event,
    });
}

// --- 4. Google Auth Routes ---

// 🏃‍♂️ ทางไป: ด่านหน้า (มึงต้องใช้ลิงก์นี้ตอนจะ Login)
app.get('/google/auth', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/userinfo.email',
            'openid'
        ]
    });
    res.redirect(url);
});

// 🏡 ทางกลับ: ด่านรับข้อมูล (Google จะส่ง Code มาที่นี่)
// ✅ แก้ให้ตรงกับที่ตั้งใน Google Console เป๊ะๆ
app.get('/login-redirect', async (req, res) => {
    const code = req.query.code; // <--- Google ส่ง code มาตรงนี้
    
    // ถ้าไม่มี code แปลว่าคนหลงเข้ามา หรือระบบวน loop
    if (!code) {
        return res.status(400).send("❌ No Code Provided: มึงอาจจะกดลิงก์ผิด ให้ไปเข้าทาง /google/auth แทน");
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const email = userInfo.data.email;

        const connection = await getConnection();
        const [rows] = await connection.execute('SELECT id, rank_name FROM users WHERE email = ?', [email]);
        
        if (rows.length > 0) {
            req.session.userId = rows[0].id;
            req.session.userName = rows[0].rank_name;
            req.session.userEmail = email;
            
            await connection.execute('UPDATE users SET google_token = ? WHERE email = ?', [JSON.stringify(tokens), email]);
            await connection.end();
            
            res.redirect('/dashboard.html'); 
        } else {
            await connection.end();
            res.send(`❌ ไม่พบอีเมล ${email} ในระบบ!`);
        }
    } catch (err) {
        console.error("❌ Login Error:", err);
        res.status(500).send("Login Failed: " + err.message);
    }
});

// --- 5. API ต่างๆ (ใช้ getConnection ที่สร้างใหม่) ---
app.post('/sync-existing-shifts', async (req, res) => {
    const { month, year, group } = req.query; // รับค่าจาก URL เช่น ?month=10&year=2024&group=กองพัน
    try {
        const connection = await getConnection();
        
        // 1. ⚡ ดึงข้อมูลเวร + Token ของแต่ละคนมาด้วย (เพิ่ม u.google_token และ s.group_name)
        const [allShifts] = await connection.execute(
            `SELECT s.*, u.rank_name, u.email, u.google_token 
             FROM shift_assignments s 
             JOIN users u ON s.user_id = u.id 
             WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ?`,
            [month, year]
        );

        // 2. ⚡ กรองเฉพาะกลุ่มที่เลือก (เช็คชื่อคอลัมน์ให้ตรงนะ ระหว่าง group_type กับ group_name)
        const targetShifts = allShifts.filter(s => s.group_name === group);

        let successCount = 0;
        let skipCount = 0;

        // 3. วนลูปส่งเข้า Google Calendar
        for (const shift of targetShifts) {
            // 🛑 ถ้าคนนี้ยังไม่เคย Login (ไม่มี Token) ให้ข้ามไปก่อน
            if (!shift.google_token) {
                console.log(`⚠️ ข้าม ${shift.rank_name}: ยังไม่ได้ผูก Google`);
                skipCount++;
                continue; 
            }

            try {
                // 🔑 สร้างกุญแจ Auth เฉพาะของทหารคนนั้นๆ
                const userAuth = new google.auth.OAuth2(
                    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
                    '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',
                    REDIRECT_URI
                );
                userAuth.setCredentials(JSON.parse(shift.google_token));

                // หาข้อมูลเวรของวันเดียวกันทั้งหมด (เพื่อทำสรุปยอดในแจ้งเตือน 07:00 น.)
                const dayShifts = allShifts.filter(s => 
                    new Date(s.shift_date).toDateString() === new Date(shift.shift_date).toDateString()
                );
                
                // 📤 ส่งเข้า Calendar ของทหารคนนั้น (ส่ง userAuth เข้าไปแทน auth ที่หายไป)
                await sendToGoogleCalendar(userAuth, shift, dayShifts); 
                successCount++;
            } catch (err) {
                console.error(`❌ ส่งให้ ${shift.rank_name} พลาด:`, err.message);
                skipCount++;
            }
        }

        await connection.end();
        res.json({ 
            success: true, 
            message: `ส่งสำเร็จ ${successCount} นาย, ข้าม ${skipCount} นาย`,
            count: successCount 
        });
    } catch (err) {
        console.error("❌ Sync Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/get-users', async (req, res) => {
    try {
        const connection = await getConnection();
        // เช็คว่า google_token มีข้อมูลไหม ถ้ามีให้ส่ง is_linked: true
        const [rows] = await connection.execute(`
            SELECT id, rank_name, role, email, 
            (google_token IS NOT NULL AND google_token != '') AS is_linked 
            FROM users 
            ORDER BY id ASC
        `);
        await connection.end();
        res.json(rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/assign-shift', async (req, res) => {
    const { user_id, shift_date, role_type, group_name, shift_turn, note } = req.body; 
    try {
        const connection = await getConnection();
        const [existing] = await connection.execute("SELECT id FROM shift_assignments WHERE user_id = ? AND shift_date = ?", [user_id, shift_date]);
        if (existing.length > 0) {
            await connection.end();
            return res.status(400).send("คนนี้มีเวรในวันที่เลือกอยู่แล้วครับ!");
        }
        await connection.execute("INSERT INTO shift_assignments (user_id, shift_date, role_type, group_name, shift_turn, note) VALUES (?, ?, ?, ?, ?, ?)", [user_id, shift_date, role_type, group_name, shift_turn, note || '']);
        const [user] = await connection.execute("SELECT google_token, rank_name FROM users WHERE id = ?", [user_id]);
        await connection.end();
        if (user.length > 0 && user[0].google_token) {
            const summary = `${role_type} (${user[0].rank_name})`;
            await addDutyToCalendar(summary, shift_date, user[0].google_token);
        }
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/delete-shift/:id', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments WHERE id = ?", [req.params.id]); 
        await connection.end();
        res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/get-report-calendar', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT s.id, s.shift_date, s.shift_turn, u.rank_name, u.role FROM shift_assignments s JOIN users u ON s.user_id = u.id WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? ORDER BY s.shift_date ASC`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/get-excel-summary', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        const sql = `SELECT u.rank_name, u.role, GROUP_CONCAT(DAY(s.shift_date) ORDER BY s.shift_date ASC) as days FROM shift_assignments s JOIN users u ON s.user_id = u.id WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ? AND s.group_name = ? GROUP BY u.id`;
        const [rows] = await connection.execute(sql, [month, year, group]);
        await connection.end();
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

// API สำหรับนำเข้ารายชื่อ (รองรับหัวข้อภาษาไทยจาก Excel ของเพื่อน)
app.post('/import-users', async (req, res) => {
    const { users } = req.body; 
    if (!users || !Array.isArray(users)) return res.status(400).send("ข้อมูลไม่ถูกต้อง");

    try {
        const connection = await getConnection();
        // เราจะเก็บ "ยศ - ชื่อ" ลงใน rank_name และ "หน้าที่" ลงใน role
        const sql = "INSERT INTO users (rank_name, role, email) VALUES (?, ?, ?)";
        
        for (const user of users) {
            // ดึงค่าตามหัวข้อในไฟล์ CSV ของเพื่อนเป๊ะๆ
            const rankAndName = user["ยศ - ชื่อ"] || "";
            const role = user["หน้าที่"] || "";
            const email = user["email"] || "";

            if (rankAndName) { // บันทึกเฉพาะแถวที่มีชื่อ
                await connection.execute(sql, [rankAndName, role, email]);
            }
        }
        
        await connection.end();
        res.send(`✅ นำเข้าสำเร็จ ${users.length} รายชื่อลง Cloud เรียบร้อย!`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

// API สำหรับล้างข้อมูลผู้ใช้ทั้งหมด
app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        // ลบข้อมูลในตาราง users ทั้งหมด
        await connection.execute("TRUNCATE TABLE users");
        await connection.end();
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send("ลบไม่สำเร็จ: " + err.message);
    }
});

// 1. API สำหรับล้างรายชื่อทหารทั้งหมด (จากปุ่ม clearAllUsers)
app.delete('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        // ลบข้อมูลเวรที่ผูกกับคนออกก่อน เพื่อป้องกัน Error ติด Foreign Key
        await connection.execute("DELETE FROM shift_assignments");
        // ลบรายชื่อทั้งหมด
        await connection.execute("DELETE FROM users"); 
        await connection.end();
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send("ลบรายชื่อไม่สำเร็จ: " + err.message);
    }
});

// 2. API สำหรับล้างข้อมูลการจัดเวรทั้งหมด (จากปุ่ม clearAllShifts)
app.get('/clear-all-users', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments");
        await connection.execute("DELETE FROM users"); 
        await connection.end();
        res.send('ok');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/clear-shifts', async (req, res) => {
    try {
        const connection = await getConnection();
        await connection.execute("DELETE FROM shift_assignments");
        await connection.end();
        res.send('✅ ล้างข้อมูลเวรเรียบร้อย!');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ==========================================
// API สำหรับหน้า Dashboard (User ส่วนตัว)
// ==========================================

// 1. API เช็คว่าใคร Login อยู่
app.get('/api/my-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Unauthorized');
    res.json({ 
        id: req.session.userId, 
        rank_name: req.session.userName,
        email: req.session.userEmail 
    });
});

// 2. API ดึงเวรเฉพาะของคนที่ Login
app.get('/get-my-duty', async (req, res) => {
    try {
        const connection = await getConnection();
        // เปลี่ยน JOIN เป็น LEFT JOIN เพื่อให้ "เวรวิทยุ" หลุดออกมาด้วย
        const [rows] = await connection.execute(
    `SELECT s.shift_date, s.role_type, u.rank_name, s.user_id 
     FROM shift_assignments s
     LEFT JOIN users u ON s.user_id = u.id 
     WHERE MONTH(s.shift_date) = 3 AND YEAR(s.shift_date) = 2026`
);
        await connection.end();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==========================================
// ฟังก์ชันที่ใช้ส่ง Calendar
// ==========================================

// 1. ฟังก์ชันปรุงข้อความแจ้งเตือน (Logic ที่เพื่อนต้องการ)
function prepareDutyMessage(myShift, allShiftsOfDay) {
    const kpCount = allShiftsOfDay.filter(s => s.group_name === 'กองพัน').length;
    const spkCount = allShiftsOfDay.filter(s => s.group_name === 'ศปก').length;
    const supervisor = allShiftsOfDay.find(s => s.role_type.includes('นายทหารเวร'));

    const loginLink = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/login-redirect`;

    if (myShift.role_type.includes('นายทหารเวร')) {
        return {
            summary: `🛡️ เวรของคุณ: ${myShift.role_type}`,
            description: `📊 สรุปยอดเวรวันนี้:\n- กองพัน: ${kpCount} นาย\n- ศปก.: ${spkCount} นาย\n\n🔗 คลิกเพื่อดูรายชื่อทั้งหมดและยืนยัน:\n${loginLink}`
        };
    } else {
        return {
            summary: `💂 เวรของคุณ: ${myShift.role_type}`,
            description: `👤 นายทหารเวรวันนี้: ${supervisor ? supervisor.rank_name : 'ยังไม่ได้ระบุ'}\n\n🔗 คลิกเพื่อดูรายละเอียดและคู่เวร:\n${loginLink}`
        };
    }
}

// 2. ฟังก์ชันส่งเข้า Google Calendar แบบตั้งเวลา 7 โมงเช้า
async function sendToGoogleCalendar(auth, shiftData, allShifts) {
    const calendar = google.calendar({ version: 'v3', auth });
    const msg = prepareDutyMessage(shiftData, allShifts);

    const event = {
        summary: msg.summary,
        description: msg.description,
        start: {
            dateTime: `${shiftData.shift_date}T08:00:00`, // ล็อคเวลาเริ่ม 08:00
            timeZone: 'Asia/Bangkok',
        },
        end: {
            dateTime: `${shiftData.shift_date}T09:00:00`,
            timeZone: 'Asia/Bangkok',
        },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 60 } // 🔥 เตือนล่วงหน้า 60 นาที = 07:00 น. พอดี!
            ]
        }
    };

    return calendar.events.insert({
        calendarId: shiftData.email,
        resource: event,
    });
}

app.post('/sync-existing-shifts', async (req, res) => {
    const { month, year, group } = req.query;
    try {
        const connection = await getConnection();
        
        // 1. ดึงข้อมูลเวร + ข้อมูลผู้ใช้ (รวมถึง google_token) มาในทีเดียวเลย
        const [allShifts] = await connection.execute(
            `SELECT s.*, u.rank_name, u.email, u.google_token 
             FROM shift_assignments s 
             JOIN users u ON s.user_id = u.id 
             WHERE MONTH(s.shift_date) = ? AND YEAR(s.shift_date) = ?`,
            [month, year]
        );

        // 2. กรองเฉพาะกลุ่มที่ Admin เลือก (กองพัน หรือ ศปก.)
        const targetShifts = allShifts.filter(s => s.group_name === group);

        let successCount = 0;
        let skipCount = 0;

        // 3. วนลูปส่งเข้า Google Calendar
        for (const shift of targetShifts) {
            // 🛑 เช็คก่อน: ถ้าไม่มี Token ให้ข้ามคนนี้ไปเลย (ไม่ให้ Error ค้าง)
            if (!shift.google_token) {
                console.log(`⚠️ ข้าม ${shift.rank_name}: ยังไม่มี Token (ยังไม่เคย Login)`);
                skipCount++;
                continue; 
            }

            try {
                // 🔑 สร้าง Auth เฉพาะตัวของทหารคนนั้น
                const userAuth = new google.auth.OAuth2(
                    '1055278075819-3degsqjsed1f3o8k35doqot6f45ih9re.apps.googleusercontent.com',
                    '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',
                    REDIRECT_URI
                );
                userAuth.setCredentials(JSON.parse(shift.google_token));

                // หาข้อมูลเวรของวันนั้น (เพื่อทำสรุปยอดในแจ้งเตือน 07:00 น.)
                const dayShifts = allShifts.filter(s => 
                    new Date(s.shift_date).toDateString() === new Date(shift.shift_date).toDateString()
                );
                
                // 📤 ส่งคำสั่งไปที่ Google Calendar
                await sendToGoogleCalendar(userAuth, shift, dayShifts); 
                successCount++;
                console.log(`✅ ส่งเวรให้ ${shift.rank_name} เรียบร้อย`);
            } catch (err) {
                console.error(`❌ ส่งให้ ${shift.rank_name} ไม่สำเร็จ:`, err.message);
                skipCount++;
            }
        }

        await connection.end();
        res.json({ 
            success: true, 
            message: `ส่งสำเร็จ ${successCount} นาย, ข้ามไป ${skipCount} นาย (ยังไม่ Login)`,
            count: successCount 
        });
    } catch (err) {
        console.error("❌ Sync Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 6. Start Server (แก้ Port ให้รองรับ Render)
const PORT = process.env.PORT || 3000; 

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ระบบพร้อมใช้งานบน Port: ${PORT}`);
});

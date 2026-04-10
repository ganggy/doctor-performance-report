require("dotenv").config();

const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3100;

const DB_CONFIG = {
  host: process.env.DB_HOST || "192.168.2.254",
  user: process.env.DB_USER || "opd",
  password: process.env.DB_PASSWORD || "opd",
  database: process.env.DB_NAME || "hos",
  waitForConnections: true,
  connectionLimit: 10
};

const ADMIN_CID = process.env.ADMIN_CID || "1480700068494";
const ADMIN_GROUP = process.env.ADMIN_GROUP || "ผู้ดูแลระบบ";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

const DATA_DIR = path.join(__dirname, "data");
const MENU_FILE = path.join(DATA_DIR, "menus.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(MENU_FILE)) {
  const initialMenus = [
    {
      id: "fdh-checker",
      title: "FDH Checker",
      description: "ระบบตรวจสอบข้อมูล FDH",
      url: "http://192.168.2.202:3507",
      color: "#005f73",
      icon: "FDH"
    }
  ];
  fs.writeFileSync(MENU_FILE, JSON.stringify(initialMenus, null, 2), "utf8");
}

const dbPool = mysql.createPool(DB_CONFIG);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);
app.use(express.static(path.join(__dirname, "public")));

function readMenus() {
  try {
    const text = fs.readFileSync(MENU_FILE, "utf8");
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

function writeMenus(menus) {
  fs.writeFileSync(MENU_FILE, JSON.stringify(menus, null, 2), "utf8");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isAdminUser(user) {
  const cid = String(user.cid || "").trim();
  const groupValue =
    user.droupname || user.groupname || user.usergroup || user.user_group || "";
  return cid === ADMIN_CID || normalizeText(groupValue) === normalizeText(ADMIN_GROUP);
}

function ensureAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: "กรุณาเข้าสู่ระบบ" });
  }
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) {
    return res.status(403).json({ ok: false, message: "สิทธิ์ไม่เพียงพอ" });
  }
  next();
}

function withProtocol(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

app.post("/api/login", async (req, res) => {
  const cid = String(req.body.cid || "").trim();
  if (!/^\d{13}$/.test(cid)) {
    return res.status(400).json({ ok: false, message: "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก" });
  }

  try {
    const [rows] = await dbPool.query("SELECT * FROM opduser WHERE cid = ? LIMIT 1", [cid]);
    if (!rows.length) {
      return res.status(401).json({ ok: false, message: "ไม่อนุญาตให้เข้าสู่ระบบ" });
    }

    const row = rows[0];
    const displayName =
      row.name || row.fullname || row.fname || row.username || row.loginname || row.cid;

    const user = {
      cid: row.cid,
      name: displayName,
      droupname: row.droupname || row.groupname || "",
      isAdmin: isAdminUser(row)
    };

    req.session.user = user;
    return res.json({
      ok: true,
      message: "สวัสดีผู้ใช้ เข้าสู่ระบบสำเร็จ",
      user
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "เชื่อมต่อฐานข้อมูลไม่สำเร็จ",
      detail: error.message
    });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: req.session.user });
});

app.get("/api/menus", ensureAuth, (req, res) => {
  return res.json({ ok: true, menus: readMenus() });
});

app.post("/api/menus", ensureAuth, ensureAdmin, (req, res) => {
  const title = String(req.body.title || "").trim();
  const url = withProtocol(req.body.url);
  const description = String(req.body.description || "").trim();
  const icon = String(req.body.icon || "").trim() || "APP";
  const color = String(req.body.color || "").trim() || "#0a9396";

  if (!title || !url) {
    return res.status(400).json({ ok: false, message: "กรุณากรอกชื่อเมนูและลิงก์" });
  }

  const menus = readMenus();
  const newMenu = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    url,
    description,
    icon,
    color
  };
  menus.push(newMenu);
  writeMenus(menus);
  return res.json({ ok: true, menu: newMenu });
});

app.put("/api/menus/:id", ensureAuth, ensureAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const menus = readMenus();
  const index = menus.findIndex((m) => m.id === id);
  if (index < 0) {
    return res.status(404).json({ ok: false, message: "ไม่พบเมนูที่ต้องการแก้ไข" });
  }

  const title = String(req.body.title || "").trim();
  const url = withProtocol(req.body.url);
  const description = String(req.body.description || "").trim();
  const icon = String(req.body.icon || "").trim() || "APP";
  const color = String(req.body.color || "").trim() || "#0a9396";

  if (!title || !url) {
    return res.status(400).json({ ok: false, message: "กรุณากรอกชื่อเมนูและลิงก์" });
  }

  menus[index] = { ...menus[index], title, url, description, icon, color };
  writeMenus(menus);
  return res.json({ ok: true, menu: menus[index] });
});

app.delete("/api/menus/:id", ensureAuth, ensureAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const menus = readMenus();
  const next = menus.filter((m) => m.id !== id);
  if (next.length === menus.length) {
    return res.status(404).json({ ok: false, message: "ไม่พบเมนูที่ต้องการลบ" });
  }
  writeMenus(next);
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

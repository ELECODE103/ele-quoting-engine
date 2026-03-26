/**
 * Authentication routes: register, login, profile.
 * Uses bcryptjs for password hashing, JWT for session tokens.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { usersDB } = require("../models");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const JWT_EXPIRES_IN = "7d";

// ─── Middleware: authenticate JWT ────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Middleware: require admin role ──────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/register
// ═══════════════════════════════════════════════════════════════
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, company, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Check if email already exists
    const existing = usersDB.getAll().find((u) => u.email === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = usersDB.insert({
      email: email.toLowerCase().trim(),
      passwordHash,
      name: name || "",
      company: company || "",
      phone: phone || "",
      role: "customer",
    });

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/login
// ═══════════════════════════════════════════════════════════════
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = usersDB.getAll().find((u) => u.email === email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/auth/profile
// ═══════════════════════════════════════════════════════════════
router.get("/profile", authenticate, (req, res) => {
  const user = usersDB.getById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    company: user.company,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt,
  });
});

// ═══════════════════════════════════════════════════════════════
// PUT /api/auth/profile
// ═══════════════════════════════════════════════════════════════
router.put("/profile", authenticate, (req, res) => {
  const { name, company, phone } = req.body;
  const updated = usersDB.update(req.user.userId, { name, company, phone });
  if (!updated) return res.status(404).json({ error: "User not found" });

  res.json({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    company: updated.company,
    phone: updated.phone,
    role: updated.role,
  });
});

module.exports = router;
module.exports.authenticate = authenticate;
module.exports.requireAdmin = requireAdmin;

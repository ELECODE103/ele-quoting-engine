/**
 * Authentication routes: register, login, profile.
 * Uses bcryptjs for password hashing, JWT for session tokens.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { usersDB } = require("../models");
const { sanitizeString, isValidEmail } = require("../middleware/validate");

const router = express.Router();

// --- JWT Secret: REQUIRE in production, warn in dev ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET environment variable is required in production");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET not set - using insecure dev fallback. Do NOT use in production.");
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-secret-DO-NOT-USE-IN-PROD";
const JWT_EXPIRES_IN = "24h";

// --- Rate Limiters for Auth Endpoints ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,                     // 5 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  skipSuccessfulRequests: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // 10 registrations per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later." },
});

// --- Password Complexity Validator ---
function validatePasswordComplexity(password) {
  const errors = [];
  if (password.length < 8) errors.push("at least 8 characters");
  if (password.length > 128) errors.push("under 128 characters");
  if (!/[A-Z]/.test(password)) errors.push("one uppercase letter");
  if (!/[a-z]/.test(password)) errors.push("one lowercase letter");
  if (!/[0-9]/.test(password)) errors.push("one number");
  return errors;
}

// --- Middleware: authenticate JWT ---
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
// --- Middleware: optional authentication ---
// Sets req.user if a valid Bearer token is present; never rejects. Used for
// endpoints that are public but should bind/scope to a user when signed in
// (e.g. quoting: anonymous is allowed, but a logged-in user's quote is theirs).
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      req.user = jwt.verify(authHeader.split(" ")[1], EFFECTIVE_JWT_SECRET);
    } catch (_) {
      /* ignore invalid/expired token for optional auth */
    }
  }
  next();
}

// --- Middleware: require admin role ---
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// POST /api/auth/register
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { email, password, name, company, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address" });
    }

    // Password complexity validation
    const pwErrors = validatePasswordComplexity(password);
    if (pwErrors.length > 0) {
      return res.status(400).json({
        error: `Password must contain: ${pwErrors.join(", ")}`,
      });
    }

    // Sanitize optional fields
    const cleanName = sanitizeString(name || "", 100);
    const cleanCompany = sanitizeString(company || "", 100);
    const cleanPhone = sanitizeString(phone || "", 30);

    // Check if email already exists
    const existing = usersDB.getAll().find((u) => u.email === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Auto-promote owner based on ADMIN_EMAIL env var (survives DB resets)
    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
    const normalizedEmail = email.toLowerCase().trim();
    const role = adminEmail && normalizedEmail === adminEmail ? "admin" : "customer";

    // Create user
    const user = usersDB.insert({
      email: normalizedEmail,
      passwordHash,
      name: cleanName,
      company: cleanCompany,
      phone: cleanPhone,
      role,
    });

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      EFFECTIVE_JWT_SECRET,
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

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
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
      EFFECTIVE_JWT_SECRET,
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

// GET /api/auth/profile
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

// PUT /api/auth/profile
router.put("/profile", authenticate, (req, res) => {
  const { name, company, phone } = req.body;

  // Sanitize all inputs
  const updates = {};
  if (name !== undefined) updates.name = sanitizeString(name, 100);
  if (company !== undefined) updates.company = sanitizeString(company, 100);
  if (phone !== undefined) updates.phone = sanitizeString(phone, 30);

  const updated = usersDB.update(req.user.userId, updates);
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
module.exports.optionalAuth = optionalAuth;
module.exports.requireAdmin = requireAdmin;

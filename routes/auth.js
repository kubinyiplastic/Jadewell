const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const { JWT_SECRET, authenticate } = require('../middleware/auth');

const router = express.Router();

// Bejelentkezés
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Felhasználónév és jelszó kötelező' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' });
    }

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aktuális felhasználó adatai
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { get } = require('../db/database');
const path = require('path');

router.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'manager' ? '/manager' : '/staff');
  }
  res.sendFile(path.join(__dirname, '../views/login.html'));
});

router.post('/login', (req, res) => {
  const { username, password, loginType } = req.body;
  const user = get('SELECT * FROM users WHERE username=?', [username]);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.redirect(`/?error=1&type=${loginType}`);
  }

  // Strict role enforcement
  if (loginType === 'admin' && user.role !== 'manager') {
    return res.redirect('/?error=2&type=admin');
  }
  if (loginType === 'staff' && user.role === 'manager') {
    return res.redirect('/?error=2&type=staff');
  }

  req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
  res.redirect(user.role === 'manager' ? '/manager' : '/staff');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;

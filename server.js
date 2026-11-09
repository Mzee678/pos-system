require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { getDb } = require('./db/database');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'nexa-cafe-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/');
  next();
};
const requireManager = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'manager') return res.redirect('/');
  next();
};

app.use('/', require('./routes/auth'));
app.use('/mpesa', require('./routes/mpesa')); // NOT behind requireLogin — /mpesa/callback must be public for Safaricom
app.use('/manager', requireLogin, requireManager, require('./routes/manager'));
app.use('/staff', requireLogin, require('./routes/staff'));
app.use('/pos', requireLogin, require('./routes/staff')); // alias
app.use('/api', requireLogin, require('./routes/api'));

getDb().then(() => {
  app.listen(3000, () => {
    console.log('');
    console.log('  ☕  NEXA POS — Ciara Café');
    console.log('  →  http://localhost:3000');
    console.log('');
    console.log('  Admin login:  admin / admin123');
    console.log('  Add staff via the Admin → Staff page');
    console.log('');
  });
});

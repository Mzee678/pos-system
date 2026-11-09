const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');

// ── CONFIG ────────────────────────────────────────────────────
// All of this comes from your .env file. See .env.example for what to fill in.
// MPESA_ENV=sandbox uses Safaricom's test environment (fake payments, safe to
// experiment). MPESA_ENV=production moves real money on your Till/Paybill.
const ENV = process.env.MPESA_ENV || 'sandbox';
const BASE_URL = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL; // e.g. https://xxxx.ngrok-free.app/mpesa/callback

// ── LOGIN GUARD (mpesa.js is mounted BEFORE the global session check,
// because /callback must stay public for Safaricom to reach it) ─────
const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
};

// ── ACCESS TOKEN (cached until it expires) ───────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error('M-Pesa credentials missing. Fill in MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET in .env');
  }
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const resp = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Failed to get M-Pesa access token: ' + JSON.stringify(data));
  }
  cachedToken = data.access_token;
  // Daraja tokens last 3600s; refresh a minute early to be safe
  tokenExpiresAt = Date.now() + (parseInt(data.expires_in || '3599', 10) - 60) * 1000;
  return cachedToken;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Normalizes 07xxxxxxxx / 7xxxxxxxx / 2547xxxxxxxx / +2547xxxxxxxx -> 2547xxxxxxxx
function formatPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('254')) return p;
  if (p.startsWith('0')) return '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) return '254' + p;
  return p;
}

// ── INITIATE STK PUSH ────────────────────────────────────────────
router.post('/stkpush', requireLogin, async (req, res) => {
  try {
    const { phone, amount, receipt_no } = req.body;
    if (!phone || !amount || !receipt_no) {
      return res.status(400).json({ error: 'phone, amount and receipt_no are required' });
    }
    if (!SHORTCODE || !PASSKEY || !CALLBACK_URL) {
      return res.status(500).json({ error: 'M-Pesa is not configured yet. Fill in .env (MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL).' });
    }

    const msisdn = formatPhone(phone);
    if (!/^2547\d{8}$/.test(msisdn) && !/^2541\d{8}$/.test(msisdn)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678' });
    }

    const token = await getAccessToken();
    const ts = timestamp();
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');

    const body = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(parseFloat(amount)),
      PartyA: msisdn,
      PartyB: SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'Ciara Cafe',
      TransactionDesc: `NEXA Sale ${receipt_no}`
    };

    const resp = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();

    if (!resp.ok || !data.CheckoutRequestID) {
      return res.status(400).json({ error: data.errorMessage || data.ResponseDescription || 'STK push failed' });
    }

    run(`INSERT INTO mpesa_transactions (receipt_no,checkout_request_id,merchant_request_id,phone,amount,status)
         VALUES (?,?,?,?,?,'pending')`,
      [receipt_no, data.CheckoutRequestID, data.MerchantRequestID, msisdn, parseFloat(amount)]);

    res.json({ success: true, checkout_request_id: data.CheckoutRequestID });
  } catch (err) {
    console.error('STK push error:', err);
    res.status(500).json({ error: err.message || 'STK push failed' });
  }
});

// ── SAFARICOM CALLBACK (public — no login, Safaricom's servers call this) ──
router.post('/callback', (req, res) => {
  try {
    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ ResultCode: 0, ResultDesc: 'Ignored' });

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stk;

    if (ResultCode === 0) {
      const items = (CallbackMetadata?.Item || []).reduce((acc, i) => { acc[i.Name] = i.Value; return acc; }, {});
      run(`UPDATE mpesa_transactions SET status='success', mpesa_receipt=?, result_desc=?, updated_at=CURRENT_TIMESTAMP WHERE checkout_request_id=?`,
        [items.MpesaReceiptNumber || null, ResultDesc, CheckoutRequestID]);
    } else {
      // ResultCode 1032 = cancelled by user, others = failed/timeout/insufficient funds etc.
      run(`UPDATE mpesa_transactions SET status='failed', result_desc=?, updated_at=CURRENT_TIMESTAMP WHERE checkout_request_id=?`,
        [ResultDesc, CheckoutRequestID]);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('M-Pesa callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always ack so Safaricom doesn't retry-storm us
  }
});

// ── STATUS POLL (frontend asks "has the customer paid yet?") ────────
router.get('/status/:checkoutId', requireLogin, (req, res) => {
  const tx = get('SELECT * FROM mpesa_transactions WHERE checkout_request_id=?', [req.params.checkoutId]);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json({ status: tx.status, mpesa_receipt: tx.mpesa_receipt, result_desc: tx.result_desc });
});

module.exports = router;


const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../public/uploads/products');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `p${req.params.id}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP images are allowed'), ok);
  }
});

const mgr = (req, res, next) => {
  if (req.session.user.role !== 'manager') return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ── PRODUCTS ──────────────────────────────────────────────────
router.get('/products', (req, res) => {
  const q = req.query.q || '';
  res.json(q
    ? all('SELECT * FROM products WHERE name LIKE ? OR category LIKE ? ORDER BY category,name', [`%${q}%`, `%${q}%`])
    : all('SELECT * FROM products ORDER BY category,name'));
});
router.post('/products', mgr, (req, res) => {
  const { name, category, subcategory, price, stock, low_stock_alert } = req.body || {};
  const newId = run('INSERT INTO products (name,category,subcategory,price,stock,low_stock_alert) VALUES (?,?,?,?,?,?)',
    [name, category, subcategory || null, parseFloat(price), parseInt(stock), parseInt(low_stock_alert) || 5]);
  res.json({ success: true, id: newId });
});
router.put('/products/:id', mgr, (req, res) => {
  const { name, category, subcategory, price, stock, low_stock_alert } = req.body || {};
  run('UPDATE products SET name=?,category=?,subcategory=?,price=?,stock=?,low_stock_alert=? WHERE id=?',
    [name, category, subcategory || null, parseFloat(price), parseInt(stock), parseInt(low_stock_alert) || 5, req.params.id]);
  res.json({ success: true });
});
router.delete('/products/:id', mgr, (req, res) => {
  run('DELETE FROM products WHERE id=?', [req.params.id]);
  res.json({ success: true });
});
router.post('/products/:id/image', mgr, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const product = get('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // clean up the old image file if it was an upload of ours
    if (product.image_url && product.image_url.startsWith('/uploads/products/')) {
      const oldPath = path.join(__dirname, '..', 'public', product.image_url);
      fs.unlink(oldPath, () => {});
    }

    const image_url = '/uploads/products/' + req.file.filename;
    run('UPDATE products SET image_url=? WHERE id=?', [image_url, req.params.id]);
    res.json({ success: true, image_url });
  });
});

// ── SALES ─────────────────────────────────────────────────────
router.post('/sales', (req, res) => {
  const { items, payment_method, amount_paid, total, receipt_no: clientReceiptNo } = req.body || {};
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  // Idempotency: a sale is only saved when the cashier actually prints the
  // receipt. If this receipt_no was already recorded (reprint, double click,
  // retry after a network blip) just return the existing record instead of
  // inserting again / deducting stock twice.
  if (clientReceiptNo) {
    const existing = get('SELECT * FROM sales WHERE receipt_no=?', [clientReceiptNo]);
    if (existing) {
      return res.json({ success: true, receipt_no: existing.receipt_no, change_given: existing.change_given, sale_id: existing.id });
    }
  }

  const receipt_no = clientReceiptNo || ('RCP-' + Date.now());
  const change_given = payment_method === 'cash' ? Math.max(0, parseFloat(amount_paid) - parseFloat(total)) : 0;
  run('INSERT INTO sales (receipt_no,cashier_id,cashier_name,payment_method,amount_paid,total,change_given) VALUES (?,?,?,?,?,?,?)',
    [receipt_no, req.session.user.id, req.session.user.name, payment_method, parseFloat(amount_paid), parseFloat(total), change_given]);
  const sale = get('SELECT * FROM sales WHERE receipt_no=?', [receipt_no]);
  items.forEach(item => {
    run('INSERT INTO sale_items (sale_id,product_id,product_name,price,quantity,subtotal) VALUES (?,?,?,?,?,?)',
      [sale.id, item.product_id, item.product_name, item.price, item.quantity, item.subtotal]);
    run('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity, item.product_id]);
  });
  res.json({ success: true, receipt_no, change_given, sale_id: sale.id });
});
router.get('/sales/summary', (req, res) => {
  const today = all(`SELECT * FROM sales WHERE date(created_at)=date('now') ORDER BY created_at DESC`);
  const totals = get(`SELECT COUNT(*) as count, SUM(total) as revenue FROM sales WHERE date(created_at)=date('now') AND status!='voided'`);
  const allTime = get(`SELECT COUNT(*) as count, SUM(total) as revenue FROM sales WHERE status!='voided'`);
  const lowStock = all(`SELECT * FROM products WHERE stock<=low_stock_alert ORDER BY stock ASC`);
  res.json({ today, totals, allTime, lowStock });
});
router.get('/sales/history', (req, res) => {
  res.json(all('SELECT * FROM sales ORDER BY created_at DESC LIMIT 200'));
});
router.get('/sales/:id/items', (req, res) => {
  res.json(all('SELECT * FROM sale_items WHERE sale_id=?', [req.params.id]));
});

// ── VOID / CANCELLATION APPROVAL ─────────────────────────────
// A cashier can't cancel a completed sale outright — they request it, and a
// manager has to approve before stock/records actually get reversed.
router.post('/sales/:id/void-request', (req, res) => {
  const sale = get('SELECT * FROM sales WHERE id=?', [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (sale.status === 'void_pending') return res.status(400).json({ error: 'A cancellation request for this sale is already pending' });
  if (sale.status === 'voided') return res.status(400).json({ error: 'This sale is already voided' });

  const { reason } = req.body || {};
  run(`INSERT INTO void_requests (sale_id,receipt_no,requested_by,requested_by_name,reason) VALUES (?,?,?,?,?)`,
    [sale.id, sale.receipt_no, req.session.user.id, req.session.user.name, reason || null]);
  run(`UPDATE sales SET status='void_pending' WHERE id=?`, [sale.id]);
  res.json({ success: true });
});

router.get('/void-requests', mgr, (req, res) => {
  res.json(all(`SELECT * FROM void_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`));
});

router.post('/void-requests/:id/approve', mgr, (req, res) => {
  const vr = get('SELECT * FROM void_requests WHERE id=?', [req.params.id]);
  if (!vr) return res.status(404).json({ error: 'Request not found' });
  if (vr.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

  const items = all('SELECT * FROM sale_items WHERE sale_id=?', [vr.sale_id]);
  items.forEach(item => {
    run('UPDATE products SET stock=stock+? WHERE id=?', [item.quantity, item.product_id]);
  });
  run(`UPDATE sales SET status='voided', voided_at=CURRENT_TIMESTAMP WHERE id=?`, [vr.sale_id]);
  run(`UPDATE void_requests SET status='approved', reviewed_by=?, reviewed_by_name=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`,
    [req.session.user.id, req.session.user.name, vr.id]);
  res.json({ success: true });
});

router.post('/void-requests/:id/reject', mgr, (req, res) => {
  const vr = get('SELECT * FROM void_requests WHERE id=?', [req.params.id]);
  if (!vr) return res.status(404).json({ error: 'Request not found' });
  if (vr.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

  const { note } = req.body || {};
  run(`UPDATE sales SET status='completed' WHERE id=?`, [vr.sale_id]);
  run(`UPDATE void_requests SET status='rejected', reviewed_by=?, reviewed_by_name=?, review_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`,
    [req.session.user.id, req.session.user.name, note || null, vr.id]);
  res.json({ success: true });
});

// ── USERS / STAFF ─────────────────────────────────────────────
router.get('/users', mgr, (req, res) => {
  res.json(all('SELECT id,name,username,role,created_at FROM users ORDER BY created_at DESC'));
});
router.post('/users', mgr, (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (get('SELECT id FROM users WHERE username=?', [username])) return res.status(400).json({ error: 'Username already exists' });
  run('INSERT INTO users (name,username,password,role) VALUES (?,?,?,?)',
    [name, username, bcrypt.hashSync(password, 10), role]);
  res.json({ success: true });
});
router.delete('/users/:id', mgr, (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── PROFILE ───────────────────────────────────────────────────
router.get('/me', (req, res) => {
  res.json(get('SELECT id,name,username,role FROM users WHERE id=?', [req.session.user.id]) || {});
});
router.put('/me', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  run('UPDATE users SET name=? WHERE id=?', [name, req.session.user.id]);
  req.session.user.name = name;
  res.json({ success: true });
});
router.put('/me/password', (req, res) => {
  const { current, new_password } = req.body || {};
  const u = get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  if (!bcrypt.compareSync(current, u.password)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(new_password, 10), req.session.user.id]);
  res.json({ success: true });
});

// ── CUSTOMERS ─────────────────────────────────────────────────
router.get('/customers', (req, res) => res.json(all('SELECT * FROM customers ORDER BY name')));
router.post('/customers', (req, res) => {
  const { name, phone, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  run('INSERT INTO customers (name,phone,email) VALUES (?,?,?)', [name, phone || null, email || null]);
  res.json({ success: true });
});
router.put('/customers/:id', (req, res) => {
  const { name, phone, email } = req.body || {};
  run('UPDATE customers SET name=?,phone=?,email=? WHERE id=?', [name, phone || null, email || null, req.params.id]);
  res.json({ success: true });
});
router.delete('/customers/:id', (req, res) => {
  run('DELETE FROM customers WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── SUPPLIERS ─────────────────────────────────────────────────
router.get('/suppliers', (req, res) => res.json(all('SELECT * FROM suppliers ORDER BY name')));
router.post('/suppliers', (req, res) => {
  const { name, phone, email, items_supplied, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  run('INSERT INTO suppliers (name,phone,email,items_supplied,notes) VALUES (?,?,?,?,?)',
    [name, phone || null, email || null, items_supplied || null, notes || null]);
  res.json({ success: true });
});
router.put('/suppliers/:id', (req, res) => {
  const { name, phone, email, items_supplied, notes } = req.body || {};
  run('UPDATE suppliers SET name=?,phone=?,email=?,items_supplied=?,notes=? WHERE id=?',
    [name, phone || null, email || null, items_supplied || null, notes || null, req.params.id]);
  res.json({ success: true });
});
router.delete('/suppliers/:id', (req, res) => {
  run('DELETE FROM suppliers WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── EXPENSES ──────────────────────────────────────────────────
router.get('/expenses', mgr, (req, res) => res.json(all('SELECT * FROM expenses ORDER BY date DESC')));
router.post('/expenses', mgr, (req, res) => {
  const { description, category, amount, date, notes } = req.body || {};
  run('INSERT INTO expenses (description,category,amount,date,notes) VALUES (?,?,?,?,?)',
    [description, category, parseFloat(amount), date, notes || null]);
  res.json({ success: true });
});
router.delete('/expenses/:id', mgr, (req, res) => {
  run('DELETE FROM expenses WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── TABLES ────────────────────────────────────────────────────
router.get('/tables', (req, res) => res.json(all('SELECT * FROM tables ORDER BY number')));
router.post('/tables', mgr, (req, res) => {
  const { number, capacity, status } = req.body || {};
  try {
    run('INSERT INTO tables (number,capacity,status) VALUES (?,?,?)',
      [parseInt(number), parseInt(capacity) || 4, status || 'free']);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: 'Table number already exists' }); }
});
router.put('/tables/:id', (req, res) => {
  const { number, capacity, status } = req.body || {};
  run('UPDATE tables SET number=?,capacity=?,status=? WHERE id=?',
    [parseInt(number), parseInt(capacity) || 4, status, req.params.id]);
  res.json({ success: true });
});
router.delete('/tables/:id', mgr, (req, res) => {
  run('DELETE FROM tables WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── ORDERS ────────────────────────────────────────────────────
router.get('/orders', mgr, (req, res) => res.json(all('SELECT * FROM orders ORDER BY created_at DESC')));
router.post('/orders', mgr, (req, res) => {
  const { table_number, customer_name, notes } = req.body || {};
  run('INSERT INTO orders (table_number,customer_name,notes,status,total,item_count) VALUES (?,?,?,?,?,?)',
    [table_number || null, customer_name || null, notes || null, 'pending', 0, 0]);
  res.json({ success: true });
});
router.put('/orders/:id', mgr, (req, res) => {
  const { status, total, item_count, notes } = req.body || {};
  run('UPDATE orders SET status=?,total=?,item_count=?,notes=? WHERE id=?',
    [status, parseFloat(total) || 0, parseInt(item_count) || 0, notes || null, req.params.id]);
  res.json({ success: true });
});
router.delete('/orders/:id', mgr, (req, res) => {
  run('DELETE FROM orders WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── REPORTS ───────────────────────────────────────────────────
router.get('/reports/revenue', mgr, (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const labels = [], data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split('T')[0];
    const row = get(`SELECT COALESCE(SUM(total),0) as rev FROM sales WHERE date(created_at)=? AND status!='voided'`, [ds]);
    labels.push(d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' }));
    data.push(parseFloat(row?.rev || 0));
  }
  res.json({ labels, data });
});
router.get('/reports/top-items', mgr, (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  res.json(all(`SELECT si.product_name as name, SUM(si.quantity) as total_qty, SUM(si.subtotal) as total_rev
    FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='voided'
    GROUP BY si.product_name ORDER BY total_qty DESC LIMIT ?`, [limit]));
});
router.get('/reports/category-revenue', mgr, (req, res) => {
  res.json(all(`SELECT p.category, COALESCE(SUM(si.subtotal),0) as revenue
    FROM products p LEFT JOIN sale_items si ON si.product_id=p.id
    LEFT JOIN sales s ON s.id=si.sale_id AND s.status!='voided'
    GROUP BY p.category ORDER BY revenue DESC`));
});
router.get('/reports/hourly', mgr, (req, res) => {
  const labels = [], data = [];
  for (let h = 6; h <= 22; h++) {
    labels.push(h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`);
    const row = get(`SELECT COUNT(*) as cnt FROM sales
      WHERE date(created_at)=date('now') AND CAST(strftime('%H',created_at) AS INTEGER)=?`, [h]);
    data.push(parseInt(row?.cnt || 0));
  }
  res.json({ labels, data });
});

module.exports = router;

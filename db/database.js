const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'nexa.db');
const initSql = require('./init');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    // Run init to create any new tables added since last run
    db.run(initSql);
    runMigrations();
    save();
  } else {
    db = new SQL.Database();
    db.run(initSql);
    runMigrations();
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (name,username,password,role) VALUES (?,?,?,?)`,
      ['Administrator','admin',hash,'manager']);
    save();
  }
  return db;
}

// Adds columns to existing tables that were created before this column
// existed. CREATE TABLE IF NOT EXISTS in init.js only helps brand-new tables;
// this handles upgrading a database that already has data in it.
function runMigrations() {
  addColumnIfMissing('products', 'image_url', 'TEXT');
  addColumnIfMissing('products', 'subcategory', 'TEXT');
  addColumnIfMissing('sales', 'status', "TEXT NOT NULL DEFAULT 'completed'");
  addColumnIfMissing('sales', 'voided_at', 'DATETIME');
}

function addColumnIfMissing(table, column, definition) {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  const cols = [];
  while (stmt.step()) cols.push(stmt.getAsObject().name);
  stmt.free();
  if (!cols.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function save() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  // Capture this BEFORE save(), because db.export() (used to persist to disk)
  // resets sql.js's internal last_insert_rowid() tracking to 0.
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const lastId = stmt.getAsObject().id;
  stmt.free();
  save();
  return lastId;
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = { getDb, run, get, all, save };

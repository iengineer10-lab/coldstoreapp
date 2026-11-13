import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mysql from 'mysql2/promise';
import { seedProducts } from './products.seed.js';
import { interpretOrder } from './order_interpreter.js';

const {
  PORT = '3000',
  DB_HOST,
  DB_PORT = '3306',
  DB_USER,
  DB_PASSWORD = '',
  DB_NAME = 'cold_store',
  ADMIN_PASSWORD,
  AUTH_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.5-flash-lite',
} = process.env;

if (!DB_HOST || !DB_USER || !ADMIN_PASSWORD) {
  console.error('Missing DB_HOST, DB_USER or ADMIN_PASSWORD. Set them in server/.env.');
  process.exit(1);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const uploadsDir = fileURLToPath(new URL('./uploads', import.meta.url));
mkdirSync(uploadsDir, { recursive: true });

// Uploaded images are stored as "/uploads/<name>" and made absolute per request.
const publicUrl = (req, url) =>
  url.startsWith('/') ? `${req.protocol}://${req.get('host')}${url}` : url;

function detectImageExtension(buffer) {
  if (buffer.length > 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
    if (
      buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
      return 'webp';
    }
  }
  return null;
}

const connection = { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD };

async function initDatabase() {
  const admin = await mysql.createConnection(connection);
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME.replace(/`/g, '')}\` CHARACTER SET utf8mb4`,
  );
  await admin.end();

  const pool = mysql.createPool({
    ...connection,
    database: DB_NAME,
    timezone: 'Z',
    connectionLimit: 10,
  });

  const [[{ storesExisted }]] = await pool.query(
    "SELECT COUNT(*) AS storesExisted FROM information_schema.tables WHERE table_schema = ? AND table_name = 'stores'",
    [DB_NAME],
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description VARCHAR(500) NOT NULL,
      unit VARCHAR(50) NOT NULL,
      image_url VARCHAR(1000) NOT NULL,
      aliases JSON NOT NULL,
      stock_quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
      name_ar VARCHAR(200) NOT NULL DEFAULT '',
      description_ar VARCHAR(500) NOT NULL DEFAULT '',
      unit_ar VARCHAR(50) NOT NULL DEFAULT ''
    )`);
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM products');
  if (total === 0) {
    await pool.query(
      'INSERT INTO products (id, name, description, unit, image_url, aliases, stock_quantity, name_ar, description_ar, unit_ar) VALUES ?',
      [
        seedProducts.map((p) => [
          p.id,
          p.name,
          p.description,
          p.unit,
          p.imageUrl,
          JSON.stringify([...p.aliases, ...p.aliasesAr]),
          p.stock,
          p.nameAr,
          p.descriptionAr,
          p.unitAr,
        ]),
      ],
    );
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id CHAR(36) PRIMARY KEY,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_orders_created_at (created_at)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id CHAR(36) NOT NULL,
      product_id VARCHAR(100) NOT NULL,
      name VARCHAR(200) NOT NULL,
      unit VARCHAR(50) NOT NULL,
      image_url VARCHAR(1000) NOT NULL,
      quantity DECIMAL(10,2) NOT NULL,
      name_ar VARCHAR(200) NOT NULL DEFAULT '',
      unit_ar VARCHAR(50) NOT NULL DEFAULT '',
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      address VARCHAR(500) NOT NULL DEFAULT '',
      phone VARCHAR(50) NOT NULL DEFAULT '',
      latitude DECIMAL(9,6) NULL,
      longitude DECIMAL(9,6) NULL,
      name_ar VARCHAR(200) NOT NULL DEFAULT '',
      address_ar VARCHAR(500) NOT NULL DEFAULT ''
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_stock (
      store_id CHAR(36) NOT NULL,
      product_id VARCHAR(100) NOT NULL,
      stock_quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (store_id, product_id),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

  const [[{ hasStoreColumn }]] = await pool.query(
    "SELECT COUNT(*) AS hasStoreColumn FROM information_schema.columns WHERE table_schema = ? AND table_name = 'orders' AND column_name = 'store_id'",
    [DB_NAME],
  );
  if (hasStoreColumn === 0) {
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN store_id CHAR(36) NULL,
        ADD CONSTRAINT fk_orders_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      name VARCHAR(200) NOT NULL,
      password_hash VARCHAR(300) NOT NULL,
      store_id CHAR(36) NOT NULL,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    )`);
  await addColumnIfMissing(pool, 'orders', 'status', "VARCHAR(20) NOT NULL DEFAULT 'new'");
  await addColumnIfMissing(pool, 'orders', 'status_updated_at', 'DATETIME(3) NULL');

  // First run with stores: move the old single-warehouse stock into a default store.
  if (storesExisted === 0) {
    const storeId = randomUUID();
    await pool.query('INSERT INTO stores (id, name) VALUES (?, ?)', [storeId, 'Main store']);
    await pool.query(
      'INSERT INTO store_stock (store_id, product_id, stock_quantity) SELECT ?, id, stock_quantity FROM products',
      [storeId],
    );
    await pool.query('UPDATE orders SET store_id = ? WHERE store_id IS NULL', [storeId]);
  }

  // Databases created before Arabic support need the extra columns.
  const addedProductColumns = await addColumnIfMissing(pool, 'products', 'name_ar', "VARCHAR(200) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'products', 'description_ar', "VARCHAR(500) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'products', 'unit_ar', "VARCHAR(50) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'stores', 'name_ar', "VARCHAR(200) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'stores', 'address_ar', "VARCHAR(500) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'order_items', 'name_ar', "VARCHAR(200) NOT NULL DEFAULT ''");
  await addColumnIfMissing(pool, 'order_items', 'unit_ar', "VARCHAR(50) NOT NULL DEFAULT ''");
  if (addedProductColumns) {
    // One-time: give the built-in products their Arabic names and search words.
    for (const seed of seedProducts) {
      const [[row]] = await pool.query('SELECT aliases FROM products WHERE id = ?', [seed.id]);
      if (!row) continue;
      const aliases = [...new Set([...row.aliases, ...seed.aliasesAr])];
      await pool.query(
        'UPDATE products SET name_ar = ?, description_ar = ?, unit_ar = ?, aliases = ? WHERE id = ?',
        [seed.nameAr, seed.descriptionAr, seed.unitAr, JSON.stringify(aliases), seed.id],
      );
    }
  }
  return pool;
}

async function addColumnIfMissing(pool, table, column, definition) {
  const [[{ present }]] = await pool.query(
    'SELECT COUNT(*) AS present FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB_NAME, table, column],
  );
  if (present > 0) return false;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  return true;
}

const isValidQuantity = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100000000;

// Returns total requested quantity per product id, or null if the payload is invalid.
function collectRequestedQuantities(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return null;
  }
  const requested = new Map();
  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      item.productId.length === 0 ||
      item.productId.length > 100 ||
      !isValidQuantity(item.quantity)
    ) {
      return null;
    }
    const total = (requested.get(item.productId) ?? 0) + item.quantity;
    requested.set(item.productId, Math.round(total * 100) / 100);
  }
  return requested;
}

const toProduct = (row) => ({
  id: row.id,
  name: row.name,
  nameAr: row.name_ar,
  description: row.description,
  descriptionAr: row.description_ar,
  unit: row.unit,
  unitAr: row.unit_ar,
  imageUrl: row.image_url,
  aliases: row.aliases,
  stock: Number(row.stock_quantity),
});

const isStockValue = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 100000000;

function parseProductInput(body) {
  const {
    name,
    description = '',
    unit,
    imageUrl,
    aliases,
    nameAr = '',
    descriptionAr = '',
    unitAr = '',
  } = body ?? {};
  const isText = (value, min, max) =>
    typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  if (
    !isText(name, 1, 200) ||
    !isText(description, 0, 500) ||
    !isText(unit, 1, 50) ||
    !isText(nameAr, 0, 200) ||
    !isText(descriptionAr, 0, 500) ||
    !isText(unitAr, 0, 50) ||
    !isText(imageUrl, 1, 1000) ||
    !/^(https?:\/\/|\/uploads\/[A-Za-z0-9-]+\.(jpg|png|webp)$)/i.test(imageUrl.trim())
  ) {
    return null;
  }
  if (
    aliases !== undefined &&
    (!Array.isArray(aliases) || aliases.length > 20 || !aliases.every((a) => isText(a, 1, 100)))
  ) {
    return null;
  }

  const cleanName = name.trim();
  const cleanNameAr = nameAr.trim();
  const cleanAliases = [...new Set((aliases ?? []).map((a) => a.trim().toLowerCase()))];
  if (cleanAliases.length === 0) {
    cleanAliases.push(cleanName.toLowerCase());
    if (cleanNameAr) cleanAliases.push(cleanNameAr);
  }
  return {
    name: cleanName,
    nameAr: cleanNameAr,
    description: description.trim(),
    descriptionAr: descriptionAr.trim(),
    unit: unit.trim(),
    unitAr: unitAr.trim(),
    imageUrl: imageUrl.trim(),
    aliases: cleanAliases,
  };
}

const toStore = (row, distanceKm = null) => ({
  id: row.id,
  name: row.name,
  nameAr: row.name_ar,
  address: row.address,
  addressAr: row.address_ar,
  phone: row.phone,
  latitude: row.latitude === null ? null : Number(row.latitude),
  longitude: row.longitude === null ? null : Number(row.longitude),
  distanceKm,
});

function parseStoreInput(body) {
  const {
    name,
    address = '',
    phone = '',
    latitude = null,
    longitude = null,
    nameAr = '',
    addressAr = '',
  } = body ?? {};
  const isText = (value, min, max) =>
    typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  const isCoordinate = (value, limit) =>
    value === null || (typeof value === 'number' && Math.abs(value) <= limit);
  if (
    !isText(name, 1, 200) ||
    !isText(address, 0, 500) ||
    !isText(phone, 0, 50) ||
    !isText(nameAr, 0, 200) ||
    !isText(addressAr, 0, 500) ||
    !isCoordinate(latitude, 90) ||
    !isCoordinate(longitude, 180) ||
    (latitude === null) !== (longitude === null)
  ) {
    return null;
  }
  return {
    name: name.trim(),
    nameAr: nameAr.trim(),
    address: address.trim(),
    addressAr: addressAr.trim(),
    phone: phone.trim(),
    latitude,
    longitude,
  };
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const digest = (value) => createHash('sha256').update(value).digest();

function adminAuth(req, res, next) {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (timingSafeEqual(digest(password), digest(ADMIN_PASSWORD))) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Cold Store Admin"');
  res.status(401).send('Authentication required.');
}

const pool = await initDatabase();

const tokenKey = digest(`staff-token:${AUTH_SECRET || ADMIN_PASSWORD}`);
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function signToken(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${b64url(createHmac('sha256', tokenKey).update(body).digest())}`;
}

function readToken(token) {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', tokenKey).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function staffAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  const payload = scheme === 'Bearer' && token ? readToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.staff = { id: payload.sub, storeId: payload.storeId };
  next();
}

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
const STATUS_TRANSITIONS = {
  new: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const app = express();
app.use(express.json({ limit: '100kb' }));

// A null storeId matches no stock rows, so every product reports 0 stock.
async function listProducts(storeId) {
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.name_ar, p.description, p.description_ar, p.unit, p.unit_ar,
            p.image_url, p.aliases,
            COALESCE(s.stock_quantity, 0) AS stock_quantity
     FROM products p
     LEFT JOIN store_stock s ON s.product_id = p.id AND s.store_id = ?
     ORDER BY p.name`,
    [storeId],
  );
  return rows.map(toProduct);
}

async function storeExists(storeId) {
  const [rows] = await pool.query('SELECT id FROM stores WHERE id = ?', [storeId]);
  return rows.length > 0;
}

app.get('/stores', async (req, res, next) => {
  const hasPosition = req.query.lat !== undefined && req.query.lng !== undefined;
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (hasPosition && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
    return res.status(400).json({ error: 'Invalid location.' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM stores ORDER BY name');
    const stores = rows.map((row) => {
      const store = toStore(row);
      if (hasPosition && store.latitude !== null) {
        store.distanceKm =
          Math.round(distanceKm(lat, lng, store.latitude, store.longitude) * 10) / 10;
      }
      return store;
    });
    stores.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    res.json(stores);
  } catch (error) {
    next(error);
  }
});

app.get('/products', async (req, res, next) => {
  const storeId = req.query.storeId;
  if (typeof storeId !== 'string' || storeId.length === 0) {
    return res.status(400).json({ error: 'storeId is required.' });
  }
  try {
    if (!(await storeExists(storeId))) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    const products = await listProducts(storeId);
    res.json(products.map((p) => ({ ...p, imageUrl: publicUrl(req, p.imageUrl) })));
  } catch (error) {
    next(error);
  }
});

let activeInterpretations = 0;
const interpretationRequests = new Map();
app.post('/orders/interpret', async (req, res, next) => {
  const { storeId, text } = req.body ?? {};
  const arabic = /^ar/i.test(req.get('accept-language') ?? '');
  if (typeof storeId !== 'string' || storeId.length === 0 || storeId.length > 100 ||
      typeof text !== 'string' || text.trim().length === 0 || text.length > 2000) {
    return res.status(400).json({ error: arabic ? 'نص الطلب غير صالح.' : 'Invalid order text.' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: arabic ? 'خدمة فهم الطلبات غير مهيأة.' : 'Order interpretation is not configured.',
    });
  }
  const now = Date.now();
  for (const [ip, entry] of interpretationRequests) {
    if (now >= entry.expires) interpretationRequests.delete(ip);
  }
  const clientIp = req.ip;
  const entry = interpretationRequests.get(clientIp);
  if ((entry && entry.count >= 20) || (!entry && interpretationRequests.size >= 10000) ||
      activeInterpretations >= 10) {
    return res.status(429).json({
      error: arabic ? 'طلبات كثيرة جداً. حاول لاحقاً.' : 'Too many requests. Please try again later.',
    });
  }
  if (entry) {
    entry.count += 1;
  } else {
    interpretationRequests.set(clientIp, { count: 1, expires: now + 60000 });
  }
  activeInterpretations += 1;
  try {
    if (!(await storeExists(storeId))) {
      return res.status(404).json({ error: arabic ? 'المتجر غير موجود.' : 'Store not found.' });
    }
    const products = await listProducts(storeId);
    let result;
    try {
      result = await interpretOrder({ text: text.trim(), products, apiKey: GEMINI_API_KEY, model: GEMINI_MODEL });
    } catch (error) {
      console.error('Order interpretation failed:', error.name, error.status ?? '');
      return res.status(502).json({
        error: arabic ? 'تعذر فهم الطلب. حاول مرة أخرى.' : 'Could not interpret the order. Please try again.',
      });
    }
    res.json({
      items: result.items.map(({ product, quantity }) => ({
        product: { ...product, imageUrl: publicUrl(req, product.imageUrl) },
        quantity,
      })),
      unresolved: result.unresolved,
    });
  } catch (error) {
    next(error);
  } finally {
    activeInterpretations -= 1;
  }
});

app.get('/admin/api/stores', adminAuth, async (_req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM stores ORDER BY name');
    res.json(rows.map((row) => toStore(row)));
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/stores', adminAuth, async (req, res, next) => {
  const store = parseStoreInput(req.body);
  if (!store) {
    return res.status(400).json({ error: 'Invalid store details.' });
  }
  try {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO stores (id, name, name_ar, address, address_ar, phone, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        store.name,
        store.nameAr,
        store.address,
        store.addressAr,
        store.phone,
        store.latitude,
        store.longitude,
      ],
    );
    res.status(201).json({ id, ...store, distanceKm: null });
  } catch (error) {
    next(error);
  }
});

app.put('/admin/api/stores/:id', adminAuth, async (req, res, next) => {
  const store = parseStoreInput(req.body);
  if (!store) {
    return res.status(400).json({ error: 'Invalid store details.' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE stores SET name = ?, name_ar = ?, address = ?, address_ar = ?, phone = ?, latitude = ?, longitude = ? WHERE id = ?',
      [
        store.name,
        store.nameAr,
        store.address,
        store.addressAr,
        store.phone,
        store.latitude,
        store.longitude,
        req.params.id,
      ],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    res.json({ id: req.params.id, ...store, distanceKm: null });
  } catch (error) {
    next(error);
  }
});

app.delete('/admin/api/stores/:id', adminAuth, async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM stores WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/products', adminAuth, async (req, res, next) => {
  const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : null;
  try {
    res.json(await listProducts(storeId));
  } catch (error) {
    next(error);
  }
});

app.put('/admin/api/stores/:storeId/products/:productId/stock', adminAuth, async (req, res, next) => {
  const stock = req.body?.stock;
  if (!isStockValue(stock)) {
    return res.status(400).json({ error: 'Stock must be a number of 0 or more.' });
  }
  try {
    await pool.query(
      `INSERT INTO store_stock (store_id, product_id, stock_quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE stock_quantity = VALUES(stock_quantity)`,
      [req.params.storeId, req.params.productId, stock],
    );
    res.json({ storeId: req.params.storeId, productId: req.params.productId, stock });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(404).json({ error: 'Store or product not found.' });
    }
    next(error);
  }
});

app.post('/admin/api/products', adminAuth, async (req, res, next) => {
  const product = parseProductInput(req.body);
  if (!product) {
    return res.status(400).json({ error: 'Invalid product details.' });
  }
  try {
    const slug =
      product.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'product';
    const [existing] = await pool.query('SELECT id FROM products WHERE id = ?', [slug]);
    const id = existing.length > 0 ? `${slug}-${randomUUID().slice(0, 6)}` : slug;

    await pool.query(
      'INSERT INTO products (id, name, name_ar, description, description_ar, unit, unit_ar, image_url, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        product.name,
        product.nameAr,
        product.description,
        product.descriptionAr,
        product.unit,
        product.unitAr,
        product.imageUrl,
        JSON.stringify(product.aliases),
      ],
    );
    res.status(201).json({ id, ...product });
  } catch (error) {
    next(error);
  }
});

app.put('/admin/api/products/:id', adminAuth, async (req, res, next) => {
  const product = parseProductInput(req.body);
  if (!product) {
    return res.status(400).json({ error: 'Invalid product details.' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE products SET name = ?, name_ar = ?, description = ?, description_ar = ?, unit = ?, unit_ar = ?, image_url = ?, aliases = ? WHERE id = ?',
      [
        product.name,
        product.nameAr,
        product.description,
        product.descriptionAr,
        product.unit,
        product.unitAr,
        product.imageUrl,
        JSON.stringify(product.aliases),
        req.params.id,
      ],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ id: req.params.id, ...product });
  } catch (error) {
    next(error);
  }
});

app.delete('/admin/api/products/:id', adminAuth, async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(
  '/uploads',
  express.static(uploadsDir, {
    setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
  }),
);

app.post(
  '/admin/api/uploads',
  adminAuth,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }),
  async (req, res, next) => {
    const extension = Buffer.isBuffer(req.body) ? detectImageExtension(req.body) : null;
    if (!extension) {
      return res.status(400).json({ error: 'Upload a JPEG, PNG or WebP image up to 5 MB.' });
    }
    try {
      const name = `${randomUUID()}.${extension}`;
      await writeFile(`${uploadsDir}/${name}`, req.body);
      res.status(201).json({ url: `/uploads/${name}` });
    } catch (error) {
      next(error);
    }
  },
);

app.use(
  '/admin',
  adminAuth,
  express.static(fileURLToPath(new URL('./public', import.meta.url)), { index: 'admin.html' }),
);

app.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.created_at, s.name AS store_name, s.name_ar AS store_name_ar
       FROM orders o LEFT JOIN stores s ON s.id = o.store_id
       ORDER BY o.created_at DESC LIMIT 200`,
    );
    if (orders.length === 0) {
      return res.json([]);
    }
    const [rows] = await pool.query(
      'SELECT order_id, product_id, name, name_ar, unit, unit_ar, image_url, quantity FROM order_items WHERE order_id IN (?) ORDER BY id',
      [orders.map((order) => order.id)],
    );
    const itemsByOrder = new Map();
    for (const row of rows) {
      const list = itemsByOrder.get(row.order_id) ?? [];
      list.push({
        productId: row.product_id,
        name: row.name,
        nameAr: row.name_ar,
        unit: row.unit,
        unitAr: row.unit_ar,
        imageUrl: publicUrl(req, row.image_url),
        quantity: Number(row.quantity),
      });
      itemsByOrder.set(row.order_id, list);
    }
    res.json(
      orders.map((order) => ({
        id: order.id,
        createdAt: order.created_at.toISOString(),
        storeName: order.store_name,
        storeNameAr: order.store_name_ar,
        items: itemsByOrder.get(order.id) ?? [],
      })),
    );
  } catch (error) {
    next(error);
  }
});

const wantsArabic = (req) => /^ar/i.test(req.get('accept-language') ?? '');

app.post('/orders', async (req, res, next) => {
  const arabic = wantsArabic(req);
  const requested = collectRequestedQuantities(req.body?.items);
  const storeId = req.body?.storeId;
  if (!requested || typeof storeId !== 'string' || storeId.length === 0) {
    return res.status(400).json({ error: arabic ? 'الطلب غير صالح.' : 'Invalid order.' });
  }

  const id = randomUUID();
  const createdAt = new Date();
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [stores] = await db.query('SELECT name, name_ar FROM stores WHERE id = ?', [storeId]);
    if (stores.length === 0) {
      throw new HttpError(
        400,
        arabic ? 'المتجر غير معروف. يرجى اختيار المتجر مرة أخرى.' : 'Unknown store. Please pick a store again.',
      );
    }
    const storeName = (arabic && stores[0].name_ar) || stores[0].name;
    const productIds = [...requested.keys()];
    const [rows] = await db.query('SELECT * FROM products WHERE id IN (?)', [productIds]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const [stockRows] = await db.query(
      'SELECT product_id, stock_quantity FROM store_stock WHERE store_id = ? AND product_id IN (?) ORDER BY product_id FOR UPDATE',
      [storeId, productIds],
    );
    const stockById = new Map(stockRows.map((row) => [row.product_id, Number(row.stock_quantity)]));

    const lines = [];
    for (const [productId, quantity] of requested) {
      const product = byId.get(productId);
      if (!product) {
        throw new HttpError(
          400,
          arabic ? `منتج غير معروف: ${productId}` : `Unknown product: ${productId}`,
        );
      }
      const available = stockById.get(productId) ?? 0;
      if (available < quantity) {
        throw new HttpError(
          409,
          arabic
            ? `المتوفر فقط ${available} ${product.unit_ar || product.unit} من ${product.name_ar || product.name} في ${storeName}.`
            : `Only ${available} ${product.unit} of ${product.name} left in stock at ${storeName}.`,
        );
      }
      lines.push({
        productId,
        name: product.name,
        nameAr: product.name_ar,
        unit: product.unit,
        unitAr: product.unit_ar,
        imageUrl: product.image_url,
        quantity,
      });
    }

    await db.query('INSERT INTO orders (id, created_at, store_id) VALUES (?, ?, ?)', [
      id,
      createdAt,
      storeId,
    ]);
    await db.query(
      'INSERT INTO order_items (order_id, product_id, name, name_ar, unit, unit_ar, image_url, quantity) VALUES ?',
      [
        lines.map((l) => [id, l.productId, l.name, l.nameAr, l.unit, l.unitAr, l.imageUrl, l.quantity]),
      ],
    );
    for (const line of lines) {
      await db.query(
        'UPDATE store_stock SET stock_quantity = stock_quantity - ? WHERE store_id = ? AND product_id = ?',
        [line.quantity, storeId, line.productId],
      );
    }
    await db.commit();
    res.status(201).json({
      id,
      createdAt: createdAt.toISOString(),
      storeName: stores[0].name,
      storeNameAr: stores[0].name_ar,
      items: lines.map((l) => ({ ...l, imageUrl: publicUrl(req, l.imageUrl) })),
    });
  } catch (error) {
    await db.rollback();
    next(error);
  } finally {
    db.release();
  }
});

const loginAttempts = new Map();

app.post('/staff/login', async (req, res, next) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      username.length === 0 || username.length > 100 || password.length === 0 || password.length > 200) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now >= entry.expires) loginAttempts.delete(ip);
  }
  const attempts = loginAttempts.get(req.ip);
  if ((attempts && attempts.count >= 10) || (!attempts && loginAttempts.size >= 10000)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  if (attempts) {
    attempts.count += 1;
  } else {
    loginAttempts.set(req.ip, { count: 1, expires: now + 60000 });
  }
  try {
    const [rows] = await pool.query(
      `SELECT st.id, st.name, st.password_hash, st.store_id, s.name AS store_name
       FROM staff st JOIN stores s ON s.id = st.store_id WHERE st.username = ?`,
      [username.trim().toLowerCase()],
    );
    const staff = rows[0];
    if (!staff || !verifyPassword(password, staff.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    res.json({
      token: signToken({ sub: staff.id, storeId: staff.store_id }),
      staff: {
        id: staff.id,
        name: staff.name,
        storeId: staff.store_id,
        storeName: staff.store_name,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/staff', adminAuth, async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT st.id, st.username, st.name, st.store_id, s.name AS store_name
       FROM staff st JOIN stores s ON s.id = st.store_id
       ORDER BY s.name, st.name, st.username`,
    );
    res.json(rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      storeId: row.store_id,
      storeName: row.store_name,
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/staff', adminAuth, async (req, res, next) => {
  const { username, name, password, storeId } = req.body ?? {};
  const isText = (value, min, max) =>
    typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  if (!isText(username, 1, 100) || !isText(name, 1, 200) || typeof password !== 'string' ||
      password.length < 8 || password.length > 200 || !isText(storeId, 1, 100)) {
    return res.status(400).json({ error: 'Invalid staff details (password needs 8+ characters).' });
  }
  try {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO staff (id, username, name, password_hash, store_id) VALUES (?, ?, ?, ?, ?)',
      [id, username.trim().toLowerCase(), name.trim(), hashPassword(password), storeId],
    );
    res.status(201).json({ id, username: username.trim().toLowerCase(), name: name.trim(), storeId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(404).json({ error: 'Store not found.' });
    }
    next(error);
  }
});

async function loadStoreOrders(req, where, params) {
  const [orders] = await pool.query(
    `SELECT o.id, o.created_at, o.status, o.status_updated_at, s.name AS store_name
     FROM orders o LEFT JOIN stores s ON s.id = o.store_id
     WHERE o.store_id = ? ${where}
     ORDER BY o.created_at DESC LIMIT 200`,
    [req.staff.storeId, ...params],
  );
  if (orders.length === 0) return [];
  const [rows] = await pool.query(
    'SELECT order_id, product_id, name, unit, image_url, quantity FROM order_items WHERE order_id IN (?) ORDER BY id',
    [orders.map((order) => order.id)],
  );
  const itemsByOrder = new Map();
  for (const row of rows) {
    const list = itemsByOrder.get(row.order_id) ?? [];
    list.push({
      productId: row.product_id,
      name: row.name,
      unit: row.unit,
      imageUrl: publicUrl(req, row.image_url),
      quantity: Number(row.quantity),
    });
    itemsByOrder.set(row.order_id, list);
  }
  return orders.map((order) => ({
    id: order.id,
    createdAt: order.created_at.toISOString(),
    status: order.status,
    statusUpdatedAt: (order.status_updated_at ?? order.created_at).toISOString(),
    storeName: order.store_name,
    items: itemsByOrder.get(order.id) ?? [],
  }));
}

app.get('/staff/orders', staffAuth, async (req, res, next) => {
  const { status, since } = req.query;
  let where = '';
  const params = [];
  if (status !== undefined) {
    if (typeof status !== 'string' || !status.split(',').every((s) => ORDER_STATUSES.includes(s))) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    where += ' AND o.status IN (?)';
    params.push(status.split(','));
  }
  if (since !== undefined) {
    const date = new Date(since);
    if (typeof since !== 'string' || Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: 'Invalid since date.' });
    }
    where += ' AND COALESCE(o.status_updated_at, o.created_at) > ?';
    params.push(date);
  }
  try {
    res.json(await loadStoreOrders(req, where, params));
  } catch (error) {
    next(error);
  }
});

app.get('/staff/orders/:id', staffAuth, async (req, res, next) => {
  try {
    const [order] = await loadStoreOrders(req, ' AND o.id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.patch('/staff/orders/:id/status', staffAuth, async (req, res, next) => {
  const status = req.body?.status;
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      'SELECT status FROM orders WHERE id = ? AND store_id = ? FOR UPDATE',
      [req.params.id, req.staff.storeId],
    );
    if (rows.length === 0) throw new HttpError(404, 'Order not found.');
    if (!STATUS_TRANSITIONS[rows[0].status].includes(status)) {
      throw new HttpError(409, `Cannot change an order from ${rows[0].status} to ${status}.`);
    }
    await db.query('UPDATE orders SET status = ?, status_updated_at = ? WHERE id = ?', [
      status,
      new Date(),
      req.params.id,
    ]);
    if (status === 'cancelled') {
      await db.query(
        `UPDATE store_stock ss JOIN order_items oi ON oi.product_id = ss.product_id
         SET ss.stock_quantity = ss.stock_quantity + oi.quantity
         WHERE oi.order_id = ? AND ss.store_id = ?`,
        [req.params.id, req.staff.storeId],
      );
    }
    await db.commit();
    const [order] = await loadStoreOrders(req, ' AND o.id = ?', [req.params.id]);
    res.json(order);
  } catch (error) {
    await db.rollback();
    next(error);
  } finally {
    db.release();
  }
});

app.get('/staff/products', staffAuth, async (req, res, next) => {
  try {
    const products = await listProducts(req.staff.storeId);
    res.json(
      products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        unit: p.unit,
        imageUrl: publicUrl(req, p.imageUrl),
        stock: p.stock,
      })),
    );
  } catch (error) {
    next(error);
  }
});

app.put('/staff/products/:productId/stock', staffAuth, async (req, res, next) => {
  const stock = req.body?.stock;
  if (!isStockValue(stock)) {
    return res.status(400).json({ error: 'Stock must be a number of 0 or more.' });
  }
  try {
    await pool.query(
      `INSERT INTO store_stock (store_id, product_id, stock_quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE stock_quantity = VALUES(stock_quantity)`,
      [req.staff.storeId, req.params.productId, stock],
    );
    res.json({ productId: req.params.productId, stock });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(404).json({ error: 'Product not found.' });
    }
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: 'Invalid request.' });
  }
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Cold store API listening on port ${PORT}`);
});

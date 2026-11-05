require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: 'postgres',
  password: 'postgres',
  database: 'wedding',
  port: 5432,
});

const app = express();
app.use(express.json());

// Auth middleware
const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.user_id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============== VENDOR ENDPOINTS ==============

// Vendor: Request payment from client
app.post('/api/payments/request', auth, async (req, res) => {
  const { clientId, bookingId, amount } = req.body;
  if (!clientId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Client ID and valid amount required' });
  }

  // Check if user is a vendor
  const vendorCheck = await pool.query(
    'SELECT id FROM vendors WHERE owner_id = $1 LIMIT 1',
    [req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Only vendors can request payment' });
  }
  const vendorId = vendorCheck.rows[0].id;

  // Generate QR code
  const paymentId = uuidv4();
  const qrData = `upi://pay?pa=wedding@pay&pn=WeddingMarketplace&am=${amount}&cu=INR&tn=${paymentId}`;
  const qrImage = await QRCode.toDataURL(qrData);

  const result = await pool.query(
    `INSERT INTO payment_requests 
     (id, from_vendor_id, to_client_id, booking_id, amount, qr_code, qr_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 minutes')
     RETURNING id, qr_code, qr_expires_at`,
    [paymentId, vendorId, clientId, bookingId || null, amount, qrImage]
  );

  res.status(201).json({
    paymentId: result.rows[0].id,
    qrCode: result.rows[0].qr_code,
    expiresAt: result.rows[0].qr_expires_at,
  });
});

// Vendor: Request release of payment (after work is done)
app.post('/api/payments/:paymentId/release', auth, async (req, res) => {
  const { paymentId } = req.params;

  const vendorCheck = await pool.query(
    'SELECT v.id FROM vendors v JOIN payment_requests pr ON pr.from_vendor_id = v.id WHERE pr.id = $1 AND v.owner_id = $2',
    [paymentId, req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await pool.query(
    `UPDATE payment_requests 
     SET status = 'released', released_at = NOW()
     WHERE id = $1 AND status = 'paid'`,
    [paymentId]
  );
  res.json({ message: 'Payment released to vendor' });
});

// ============== CLIENT ENDPOINTS ==============

// Client: Check payment status
app.get('/api/payments/:paymentId/status', auth, async (req, res) => {
  const { paymentId } = req.params;
  const result = await pool.query(
    `SELECT pr.*, u.name as client_name, v.name as vendor_name
     FROM payment_requests pr
     JOIN users u ON pr.to_client_id = u.id
     JOIN vendors v ON pr.from_vendor_id = v.id
     WHERE pr.id = $1`,
    [paymentId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Payment request not found' });
  }
  res.json(result.rows[0]);
});

// ============== ADMIN ENDPOINTS ==============

// Admin: List all payment requests
app.get('/api/admin/payments', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const result = await pool.query(
    `SELECT pr.*, 
            u.name as client_name, u.email as client_email,
            v.name as vendor_name
     FROM payment_requests pr
     JOIN users u ON pr.to_client_id = u.id
     JOIN vendors v ON pr.from_vendor_id = v.id
     ORDER BY pr.created_at DESC`
  );
  res.json(result.rows);
});

// Admin: Update amount of a pending payment request
app.put('/api/admin/payments/:paymentId/amount', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { paymentId } = req.params;
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }

  const result = await pool.query(
    `UPDATE payment_requests 
     SET amount = $1
     WHERE id = $2 AND status = 'pending' AND qr_expires_at > NOW()
     RETURNING *`,
    [amount, paymentId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or cannot be modified' });
  }
  // Regenerate QR with new amount
  const qrData = `upi://pay?pa=wedding@pay&pn=WeddingMarketplace&am=${amount}&cu=INR&tn=${paymentId}`;
  const qrImage = await QRCode.toDataURL(qrData);
  await pool.query(
    `UPDATE payment_requests SET qr_code = $1 WHERE id = $2`,
    [qrImage, paymentId]
  );
  result.rows[0].qr_code = qrImage;

  res.json({ message: 'Amount updated', payment: result.rows[0] });
});

// Admin: Confirm payment (simulate payment success)
app.post('/api/payments/:paymentId/confirm', auth, async (req, res) => {
  const { paymentId } = req.params;
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Only admin can confirm payments' });
  }

  await pool.query(
    `UPDATE payment_requests 
     SET status = 'paid', paid_at = NOW()
     WHERE id = $1 AND status = 'pending' AND qr_expires_at > NOW()`,
    [paymentId]
  );
  res.json({ message: 'Payment confirmed' });
});

// Admin: Cancel a payment request
app.delete('/api/admin/payments/:paymentId', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { paymentId } = req.params;
  const result = await pool.query(
    `UPDATE payment_requests SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING *`,
    [paymentId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or already processed' });
  }
  res.json({ message: 'Payment cancelled', payment: result.rows[0] });
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(`Payment service running on port ${PORT}`));
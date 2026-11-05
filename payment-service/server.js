require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const axios = require('axios');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: 'postgres',
  password: 'postgres',
  database: 'wedding',
  port: 5432,
});

const app = express();
app.use(express.json());

// ---------- Broadcast Helper ----------
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://chat-service:30001';

async function broadcastMessage(toUserId, content, type = 'payment', fromUserId = 'system') {
  try {
    await axios.post(`${CHAT_SERVICE_URL}/internal/broadcast`, {
      toUserId,
      content,
      type,
      fromUserId,
    });
  } catch (err) {
    console.error(`Failed to broadcast to user ${toUserId}:`, err.message);
  }
}

// ---------- Notification Helper ----------
async function sendNotification(userId, type, title, content, relatedId = null, deepLink = null) {
  try {
    const query = `
      INSERT INTO notifications (user_id, type, title, content, related_id, deep_link, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `;
    await pool.query(query, [userId, type, title, content, relatedId, deepLink]);
    await broadcastMessage(userId, `${title}: ${content}`, 'notification');
  } catch (err) {
    console.error('Failed to send notification:', err);
  }
}

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

// ========== OTP Utility Functions (with Lockout) ==========

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function getLockoutDuration(attempts) {
  if (attempts <= 4) return 0;
  if (attempts <= 6) return 10 * 60 * 1000;      // 10 minutes
  if (attempts <= 8) return 60 * 60 * 1000;      // 1 hour
  if (attempts <= 10) return 24 * 60 * 60 * 1000; // 1 day
  return 2 * 24 * 60 * 60 * 1000;                 // 2 days
}

async function createAndSendOTP(identifier, action, broadcastUserId, broadcastContent) {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes expiry

  await pool.query(
    `INSERT INTO otp_attempts (identifier, otp, expires_at, attempts, locked_until, verified, action)
     VALUES ($1, $2, $3, 0, NULL, false, $4)`,
    [identifier, otp, expiresAt, action]
  );

  if (broadcastUserId && broadcastContent) {
    await broadcastMessage(broadcastUserId, `${broadcastContent} ${otp}`, 'payment');
  }

  return otp;
}

async function verifyOTP(identifier, otp, action) {
  const result = await pool.query(
    `SELECT * FROM otp_attempts 
     WHERE identifier = $1 AND action = $2 AND verified = false 
     ORDER BY created_at DESC LIMIT 1`,
    [identifier, action]
  );

  if (result.rows.length === 0) {
    return { valid: false, error: 'No OTP request found for this action' };
  }

  let record = result.rows[0];

  console.log('🔍 verifyOTP - identifier:', identifier, 'action:', action, 'stored OTP:', record.otp, 'received OTP:', otp);

  if (record.locked_until && new Date(record.locked_until) > new Date()) {
    const remaining = Math.ceil((new Date(record.locked_until) - new Date()) / 60000);
    return { valid: false, error: `Too many attempts. Try again in ${remaining} minutes.` };
  }

  if (new Date(record.expires_at) < new Date()) {
    return { valid: false, error: 'OTP expired' };
  }

  if (record.otp !== String(otp)) {
    const newAttempts = record.attempts + 1;
    const lockDuration = getLockoutDuration(newAttempts);
    let lockedUntil = null;
    if (lockDuration > 0) {
      lockedUntil = new Date(Date.now() + lockDuration);
    }

    await pool.query(
      `UPDATE otp_attempts SET attempts = $1, locked_until = $2 WHERE id = $3`,
      [newAttempts, lockedUntil, record.id]
    );

    if (lockedUntil) {
      const mins = Math.ceil(lockDuration / 60000);
      return { valid: false, error: `Too many attempts. Try again in ${mins} minutes.` };
    }
    return { valid: false, error: 'Invalid OTP' };
  }

  await pool.query(
    `UPDATE otp_attempts SET verified = true, attempts = 0, locked_until = NULL WHERE id = $1`,
    [record.id]
  );

  return { valid: true, error: null };
}

// ==================== VENDOR ENDPOINTS ====================

// 1. Request payment from client (generates QR) – with UPI validation
app.post('/api/payments/request', auth, async (req, res) => {
  const { clientId, bookingId, amount } = req.body;
  if (!clientId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Client ID and valid amount required' });
  }

  const vendorCheck = await pool.query(
    'SELECT id, upi_id, upi_name FROM vendors WHERE owner_id = $1 LIMIT 1',
    [req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Only vendors can request payment' });
  }

  const vendor = vendorCheck.rows[0];

  if (!vendor.upi_id || !vendor.upi_name) {
    return res.status(400).json({
      error: 'Please fill your UPI details before requesting payment',
      message: 'UPI_FORM_REQUIRED'
    });
  }

  const vendorId = vendor.id;

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

  // Notify client with deep link to payment
  await sendNotification(
    clientId,
    'payment',
    'Payment Requested',
    `Vendor has requested ₹${amount} for booking ${bookingId || 'your booking'}.`,
    paymentId,
    `/payment?paymentId=${paymentId}`
  );

  res.status(201).json({
    paymentId: result.rows[0].id,
    qrCode: result.rows[0].qr_code,
    expiresAt: result.rows[0].qr_expires_at,
  });
});

// 2. Vendor marks arrival (legacy)
app.post('/api/vendor/arrive', auth, async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID required' });
  }

  const vendorCheck = await pool.query(
    `SELECT v.id FROM vendors v 
     JOIN bookings b ON b.vendor_id = v.id 
     WHERE b.id = $1 AND v.owner_id = $2`,
    [bookingId, req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized for this booking' });
  }

  const otp = generateOTP();
  const result = await pool.query(
    `INSERT INTO vendor_work_status 
     (vendor_id, booking_id, client_id, status, arrived_at, otp, otp_expires_at)
     SELECT v.id, $1, b.client_id, 'arrived', NOW(), $2, NOW() + INTERVAL '1 hour'
     FROM vendors v
     JOIN bookings b ON b.id = $1
     WHERE v.owner_id = $3
     RETURNING id, otp, client_id`,
    [bookingId, otp, req.userId]
  );

  await broadcastMessage(
    result.rows[0].client_id,
    `Your vendor has arrived at the location. OTP for work completion: ${otp}`,
    'payment'
  );

  res.json({
    message: 'Arrival marked',
    otp: result.rows[0].otp,
    clientId: result.rows[0].client_id,
  });
});

// 3. Vendor marks work as in progress (legacy)
app.post('/api/vendor/complete-work', auth, async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID required' });
  }

  const result = await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'working', working_at = NOW()
     WHERE booking_id = $1 
     AND vendor_id = (SELECT id FROM vendors WHERE owner_id = $2)
     RETURNING client_id`,
    [bookingId, req.userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Booking not found or not assigned' });
  }

  await broadcastMessage(
    result.rows[0].client_id,
    'Your vendor has started the work.',
    'payment'
  );

  res.json({ message: 'Work in progress', clientId: result.rows[0].client_id });
});

// 4. Vendor claims payment (legacy)
app.post('/api/vendor/claim-payment', auth, async (req, res) => {
  const { bookingId, otp } = req.body;
  if (!bookingId || !otp) {
    return res.status(400).json({ error: 'Booking ID and OTP required' });
  }

  const result = await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'claimed', claimed_at = NOW()
     WHERE booking_id = $1 
     AND vendor_id = (SELECT id FROM vendors WHERE owner_id = $2)
     AND otp = $3 
     AND otp_expires_at > NOW()
     AND status = 'working'
     RETURNING client_id`,
    [bookingId, req.userId, otp]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid OTP or work not in progress' });
  }

  await pool.query(
    `UPDATE payment_requests 
     SET status = 'released', released_at = NOW()
     WHERE booking_id = $1 AND status = 'paid'`,
    [bookingId]
  );

  const clientId = result.rows[0].client_id;
  await broadcastMessage(
    clientId,
    'Payment has been released to the vendor. Thank you for using our service!',
    'payment'
  );
  await broadcastMessage(
    req.userId,
    'Payment has been successfully released to you after client verification.',
    'payment'
  );

  res.json({ message: 'Payment claimed successfully', clientId });
});

// 5. Vendor payment history
app.get('/api/vendor/payments', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT pr.*, u.name as client_name, u.email as client_email
     FROM payment_requests pr
     JOIN users u ON pr.to_client_id = u.id
     WHERE pr.from_vendor_id = (SELECT id FROM vendors WHERE owner_id = $1)
     ORDER BY pr.created_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

// ================================================================
// VENDOR UPI ENDPOINT
// ================================================================
app.put('/api/vendor/upi', auth, async (req, res) => {
  const { upiId, upiName } = req.body;
  if (!upiId) {
    return res.status(400).json({ error: 'UPI ID is required' });
  }

  const vendorCheck = await pool.query(
    'SELECT id FROM vendors WHERE owner_id = $1',
    [req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Only vendors can update UPI details' });
  }

  await pool.query(
    `UPDATE vendors SET upi_id = $1, upi_name = $2 WHERE owner_id = $3`,
    [upiId, upiName || null, req.userId]
  );

  res.json({ message: 'UPI details updated successfully' });
});

// ================================================================
// NEW OTP FLOW with Commission & Pending Payout
// ================================================================

// 5a. Vendor starts work – OTP sent to client
app.post('/api/vendor/start-work', auth, async (req, res) => {
  const { bookingId, latitude, longitude } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID required' });
  }

  const vendorCheck = await pool.query(
    `SELECT v.id FROM vendors v 
     JOIN bookings b ON b.vendor_id = v.id 
     WHERE b.id = $1 AND v.owner_id = $2`,
    [bookingId, req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized for this booking' });
  }

  const clientResult = await pool.query(
    'SELECT client_id FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (clientResult.rows.length === 0) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  const clientId = clientResult.rows[0].client_id;

  const otp = await createAndSendOTP(
    bookingId,
    'start_work',
    clientId,
    'Your vendor has arrived. Please share this OTP to start the timer:'
  );

  await pool.query('DELETE FROM vendor_work_status WHERE booking_id = $1', [bookingId]);

  await pool.query(
    `INSERT INTO vendor_work_status 
     (vendor_id, booking_id, client_id, status, start_time, location_lat, location_lng, work_otp, work_otp_expires_at)
     VALUES ($1, $2, $3, 'started', NOW(), $4, $5, $6, NOW() + INTERVAL '2 minutes')`,
    [vendorCheck.rows[0].id, bookingId, clientId, latitude || null, longitude || null, otp]
  );

  res.json({
    message: 'OTP sent to client. Vendor must enter the OTP to start work.',
    clientId: clientId,
  });
});

// 5b. Vendor confirms start
app.post('/api/vendor/confirm-start', auth, async (req, res) => {
  const { bookingId, otp, duration } = req.body;
  if (!bookingId || !otp) {
    return res.status(400).json({ error: 'Booking ID and OTP required' });
  }

  const result = await verifyOTP(bookingId, otp, 'start_work');
  if (!result.valid) {
    return res.status(400).json({ error: result.error });
  }

  await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'working', 
         duration_hours = $2
     WHERE booking_id = $1 AND status = 'started'`,
    [bookingId, duration || 2]
  );

  const clientId = (await pool.query('SELECT client_id FROM bookings WHERE id = $1', [bookingId])).rows[0].client_id;
  await broadcastMessage(
    clientId,
    'Your vendor has started working. Timer has started.',
    'payment'
  );

  res.json({ message: 'Work started successfully' });
});

// 5c. Vendor clicks "Work Done" – second OTP
app.post('/api/vendor/complete-work-otp', auth, async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID required' });
  }

  const vendorCheck = await pool.query(
    `SELECT v.id FROM vendors v 
     JOIN bookings b ON b.vendor_id = v.id 
     WHERE b.id = $1 AND v.owner_id = $2`,
    [bookingId, req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const clientResult = await pool.query(
    'SELECT client_id FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (clientResult.rows.length === 0) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  const clientId = clientResult.rows[0].client_id;

  const otp = await createAndSendOTP(
    bookingId,
    'complete_work',
    clientId,
    'Vendor has completed the work. Please share this OTP to confirm:'
  );

  await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'waiting_completion',
         work_otp = $2,
         work_otp_expires_at = NOW() + INTERVAL '2 minutes'
     WHERE booking_id = $1 AND status = 'working'`,
    [bookingId, otp]
  );

  res.json({
    message: 'Completion OTP sent to client.',
    clientId: clientId,
  });
});

// 5d. Vendor confirms completion – calculates commission, sets payout pending
app.post('/api/vendor/confirm-completion', auth, async (req, res) => {
  const { bookingId, otp } = req.body;
  if (!bookingId || !otp) {
    return res.status(400).json({ error: 'Booking ID and OTP required' });
  }

  const result = await verifyOTP(bookingId, otp, 'complete_work');
  if (!result.valid) {
    return res.status(400).json({ error: result.error });
  }

  await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'completed', end_time = NOW()
     WHERE booking_id = $1 AND status = 'waiting_completion'`,
    [bookingId]
  );

  const paymentResult = await pool.query(
    `SELECT id, amount FROM payment_requests 
     WHERE booking_id = $1 AND status = 'paid'`,
    [bookingId]
  );
  if (paymentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Paid payment not found for this booking' });
  }
  const payment = paymentResult.rows[0];
  const amount = parseFloat(payment.amount);

  const commissionRate = amount > 10000 ? 4 : 2;
  const commissionAmount = (commissionRate / 100) * amount;
  const netAmount = amount - commissionAmount;

  await pool.query(
    `UPDATE payment_requests 
     SET status = 'released', 
         released_at = NOW(),
         commission_rate = $2,
         commission_amount = $3,
         net_amount = $4,
         payout_status = 'pending'
     WHERE id = $1`,
    [payment.id, commissionRate, commissionAmount, netAmount]
  );

  await pool.query(
    `UPDATE bookings SET status = 'completed' WHERE id = $1`,
    [bookingId]
  );

  const clientId = (await pool.query('SELECT client_id FROM bookings WHERE id = $1', [bookingId])).rows[0].client_id;

  // Notify client & vendor with deep link to booking
  await sendNotification(
    clientId,
    'payment',
    'Work Completed',
    `Work completed for booking ${bookingId}. Payment released to vendor.`,
    bookingId,
    `/booking?bookingId=${bookingId}`
  );
  await sendNotification(
    req.userId,
    'payment',
    'Payment Released',
    `Net amount ₹${netAmount.toFixed(2)} (commission ₹${commissionAmount.toFixed(2)}) pending admin payout.`,
    bookingId,
    `/booking?bookingId=${bookingId}`
  );

  await broadcastMessage(
    'admin_monitor',
    `New pending payout: ₹${netAmount.toFixed(2)} for booking ${bookingId}`,
    'admin'
  );

  res.json({
    message: 'Work completed and payment released',
    amount,
    commissionRate,
    commissionAmount,
    netAmount,
  });
});

// ================================================================
// ADMIN: View pending payouts
// ================================================================
app.get('/api/admin/pending-payouts', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const result = await pool.query(
    `SELECT pr.*, 
            u.name as client_name, 
            v.name as vendor_name,
            v.upi_id as vendor_upi_id,
            v.upi_name as vendor_upi_name,
            b.event_date
     FROM payment_requests pr
     JOIN users u ON pr.to_client_id = u.id
     JOIN vendors v ON pr.from_vendor_id = v.id
     JOIN bookings b ON pr.booking_id = b.id
     WHERE pr.payout_status = 'pending' AND pr.status = 'released'
     ORDER BY pr.released_at DESC`
  );
  res.json(result.rows);
});

// ================================================================
// ADMIN: Process payout with UPI
// ================================================================
app.post('/api/admin/process-payout', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { paymentId, adminUpiId, upiPin } = req.body;
  if (!paymentId || !adminUpiId || !upiPin) {
    return res.status(400).json({ error: 'Payment ID, admin UPI ID, and UPI PIN required' });
  }

  const ADMIN_UPI_PIN = process.env.ADMIN_UPI_PIN || '1234';
  if (upiPin !== ADMIN_UPI_PIN) {
    return res.status(403).json({ error: 'Invalid UPI PIN' });
  }

  const paymentResult = await pool.query(
    `SELECT pr.*, v.upi_id as vendor_upi_id, v.name as vendor_name
     FROM payment_requests pr
     JOIN vendors v ON pr.from_vendor_id = v.id
     WHERE pr.id = $1 AND pr.payout_status = 'pending' AND pr.status = 'released'`,
    [paymentId]
  );

  if (paymentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or already processed' });
  }

  const payment = paymentResult.rows[0];
  const vendorUpiId = payment.vendor_upi_id;

  if (!vendorUpiId) {
    return res.status(400).json({ error: 'Vendor has not set their UPI ID yet' });
  }

  const transactionRef = 'TXN' + Date.now();

  await pool.query(
    `UPDATE payment_requests 
     SET payout_status = 'processed', 
         payout_date = NOW(),
         admin_upi_id = $2,
         transaction_ref = $3
     WHERE id = $1`,
    [paymentId, adminUpiId, transactionRef]
  );

  await sendNotification(
    payment.from_vendor_id,
    'payment',
    'Payout Processed',
    `Payment of ₹${payment.net_amount} sent to your UPI ID (${vendorUpiId}). Ref: ${transactionRef}`,
    paymentId,
    `/payment?paymentId=${paymentId}`
  );

  res.json({
    message: 'Payout processed successfully',
    transactionRef,
    vendorUpiId,
    netAmount: payment.net_amount,
  });
});

// ================================================================
// Vendor: View payout history
// ================================================================
app.get('/api/vendor/payout-history', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT pr.id, pr.amount, pr.commission_rate, pr.commission_amount, pr.net_amount, 
            pr.payout_status, pr.payout_date, pr.released_at,
            u.name as client_name, b.event_date
     FROM payment_requests pr
     JOIN users u ON pr.to_client_id = u.id
     JOIN bookings b ON pr.booking_id = b.id
     WHERE pr.from_vendor_id = (SELECT id FROM vendors WHERE owner_id = $1)
       AND pr.status = 'released'
     ORDER BY pr.released_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

// ================================================================
// CLIENT ENDPOINTS
// ================================================================

app.get('/api/client/payments', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT pr.*, v.name as vendor_name
     FROM payment_requests pr
     JOIN vendors v ON pr.from_vendor_id = v.id
     WHERE pr.to_client_id = $1
     ORDER BY pr.created_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

// ================================================================
// UPDATED CLIENT REFUND ENDPOINT
// ================================================================
app.post('/api/client/refund', auth, async (req, res) => {
  const { paymentId, reason } = req.body;
  if (!paymentId || !reason) {
    return res.status(400).json({ error: 'Payment ID and reason required' });
  }

  const paymentCheck = await pool.query(
    `SELECT pr.*, b.event_date 
     FROM payment_requests pr
     JOIN bookings b ON pr.booking_id = b.id
     WHERE pr.id = $1 AND pr.to_client_id = $2 AND pr.status = 'paid'`,
    [paymentId, req.userId]
  );
  if (paymentCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or cannot be refunded' });
  }

  const payment = paymentCheck.rows[0];
  const eventDate = new Date(payment.event_date);
  const now = new Date();
  const hoursDiff = (eventDate - now) / (1000 * 60 * 60);

  let refundPercent = 0;
  if (hoursDiff >= 36) {
    refundPercent = 100;
  } else if (hoursDiff >= 24) {
    refundPercent = 50;
  } else {
    refundPercent = 0;
  }

  if (refundPercent === 0) {
    return res.status(400).json({ error: 'No refund available (less than 24 hours before event).' });
  }

  const grossRefund = parseFloat((payment.amount * refundPercent / 100).toFixed(2));
  let netRefund = grossRefund;
  let platformFee = 0;

  if (refundPercent === 100) {
    platformFee = parseFloat((grossRefund * 0.01).toFixed(2));
    netRefund = parseFloat((grossRefund - platformFee).toFixed(2));
  }

  const platformCut = parseFloat((payment.amount - netRefund).toFixed(2));
  const vendorAmount = 0;

  const result = await pool.query(
    `INSERT INTO refund_requests 
     (payment_request_id, client_id, amount, net_refund, platform_fee, reason, platform_cut, vendor_amount, refund_percentage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [paymentId, req.userId, grossRefund, netRefund, platformFee, reason, platformCut, vendorAmount, refundPercent]
  );

  // Notify admin
  await sendNotification(
    'admin',
    'refund',
    'Refund Requested',
    `New refund request: ₹${netRefund} (gross ₹${grossRefund}) for client ${req.userId} (${refundPercent}% refund).`,
    result.rows[0].id,
    '/admin/refunds'
  );

  res.json({
    message: 'Refund request submitted',
    refundId: result.rows[0].id,
    grossRefund,
    netRefund,
    platformFee,
    refundPercentage: refundPercent
  });
});

app.post('/api/client/verify-otp', auth, async (req, res) => {
  const { bookingId, otp } = req.body;
  if (!bookingId || !otp) {
    return res.status(400).json({ error: 'Booking ID and OTP required' });
  }

  const result = await pool.query(
    `UPDATE vendor_work_status 
     SET status = 'completed', completed_at = NOW()
     WHERE booking_id = $1 
     AND client_id = $2
     AND otp = $3 
     AND otp_expires_at > NOW()
     AND status = 'working'
     RETURNING vendor_id`,
    [bookingId, req.userId, otp]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid OTP or work not in progress' });
  }

  await pool.query(
    `UPDATE payment_requests 
     SET status = 'released', released_at = NOW()
     WHERE booking_id = $1 AND status = 'paid'`,
    [bookingId]
  );

  await pool.query(
    `UPDATE bookings SET status = 'completed' WHERE id = $1`,
    [bookingId]
  );

  await sendNotification(
    req.userId,
    'payment',
    'Payment Released',
    `OTP verified. Payment has been released to the vendor for booking ${bookingId}.`,
    bookingId,
    `/booking?bookingId=${bookingId}`
  );
  await sendNotification(
    result.rows[0].vendor_id,
    'payment',
    'Payment Released',
    `Client verified work. Payment released to you for booking ${bookingId}.`,
    bookingId,
    `/booking?bookingId=${bookingId}`
  );

  res.json({ message: 'OTP verified, payment released' });
});

// ==================== ADMIN ENDPOINTS ====================

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
    `UPDATE payment_requests SET amount = $1
     WHERE id = $2 AND status = 'pending' AND qr_expires_at > NOW()
     RETURNING *`,
    [amount, paymentId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or cannot be modified' });
  }

  const qrData = `upi://pay?pa=wedding@pay&pn=WeddingMarketplace&am=${amount}&cu=INR&tn=${paymentId}`;
  const qrImage = await QRCode.toDataURL(qrData);
  await pool.query(`UPDATE payment_requests SET qr_code = $1 WHERE id = $2`, [qrImage, paymentId]);
  result.rows[0].qr_code = qrImage;

  await broadcastMessage(
    result.rows[0].to_client_id,
    `Admin has updated the payment amount to ₹${amount}. Please check the QR code.`,
    'payment'
  );
  await broadcastMessage(
    req.userId,
    `Admin has updated the payment amount to ₹${amount}.`,
    'payment'
  );

  res.json({ message: 'Amount updated', payment: result.rows[0] });
});

app.post('/api/payments/:paymentId/confirm', auth, async (req, res) => {
  const { paymentId } = req.params;
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Only admin can confirm payments' });
  }

  const result = await pool.query(
    `UPDATE payment_requests SET status = 'paid', paid_at = NOW()
     WHERE id = $1 AND status = 'pending' AND qr_expires_at > NOW()
     RETURNING *`,
    [paymentId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found or cannot be confirmed' });
  }

  const payment = result.rows[0];

  if (payment.booking_id) {
    await pool.query(
      `UPDATE bookings SET status = 'confirmed' WHERE id = $1`,
      [payment.booking_id]
    );
  }

  // Notify client & vendor
  await sendNotification(
    payment.to_client_id,
    'payment',
    'Payment Confirmed',
    `Your payment of ₹${payment.amount} has been confirmed.`,
    payment.booking_id,
    `/booking?bookingId=${payment.booking_id}`
  );
  await sendNotification(
    payment.from_vendor_id,
    'payment',
    'Payment Confirmed',
    `Payment of ₹${payment.amount} confirmed for booking ${payment.booking_id}.`,
    payment.booking_id,
    `/booking?bookingId=${payment.booking_id}`
  );

  res.json({ message: 'Payment confirmed' });
});

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

app.post('/api/admin/refund/:refundId/process', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { refundId } = req.params;
  const { status } = req.body;

  const result = await pool.query(
    `UPDATE refund_requests SET status = $1, processed_at = NOW()
     WHERE id = $2 RETURNING *`,
    [status, refundId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Refund not found' });
  }

  const refund = result.rows[0];
  if (status === 'approved') {
    await pool.query(
      `UPDATE payment_requests SET status = 'refunded', refunded_at = NOW()
       WHERE id = $1`,
      [refund.payment_request_id]
    );

    await sendNotification(
      refund.client_id,
      'refund',
      'Refund Approved',
      `Your refund of ₹${refund.net_refund || refund.amount} has been approved.`,
      refund.payment_request_id,
      `/payment?paymentId=${refund.payment_request_id}`
    );
  } else {
    await sendNotification(
      refund.client_id,
      'refund',
      'Refund Rejected',
      `Your refund request has been rejected.`,
      refund.payment_request_id,
      `/payment?paymentId=${refund.payment_request_id}`
    );
  }

  res.json({ message: `Refund ${status}`, refund });
});

app.get('/api/admin/refunds', auth, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const result = await pool.query(
    `SELECT r.*, u.name as client_name, v.name as vendor_name
     FROM refund_requests r
     JOIN users u ON r.client_id = u.id
     JOIN payment_requests pr ON r.payment_request_id = pr.id
     JOIN vendors v ON pr.from_vendor_id = v.id
     ORDER BY r.created_at DESC`
  );
  res.json(result.rows);
});

// ==================== LOCATION ENDPOINTS ====================

app.post('/api/location/update', auth, async (req, res) => {
  const { latitude, longitude, accuracy } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Latitude and longitude required' });
  }

  await pool.query(
    `INSERT INTO user_locations (user_id, latitude, longitude, accuracy, is_active, updated_at)
     VALUES ($1, $2, $3, $4, true, NOW())
     ON CONFLICT (user_id) DO UPDATE SET 
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       accuracy = EXCLUDED.accuracy,
       updated_at = NOW(),
       is_active = true`,
    [req.userId, latitude, longitude, accuracy || null]
  );

  res.json({ message: 'Location updated' });
});

app.get('/api/location/nearby', auth, async (req, res) => {
  const { lat, lng, radius = 10 } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Latitude and longitude required' });
  }

  const result = await pool.query(
    `SELECT v.*, ul.latitude, ul.longitude,
      (6371 * acos(cos(radians($1)) * cos(radians(ul.latitude)) * cos(radians(ul.longitude) - radians($2)) + sin(radians($1)) * sin(radians(ul.latitude)))) AS distance
     FROM vendors v
     JOIN user_locations ul ON ul.user_id = v.owner_id
     WHERE v.approved = true
       AND ul.is_active = true
       AND (6371 * acos(cos(radians($1)) * cos(radians(ul.latitude)) * cos(radians(ul.longitude) - radians($2)) + sin(radians($1)) * sin(radians(ul.latitude)))) < $3
     ORDER BY distance ASC`,
    [lat, lng, radius]
  );

  res.json(result.rows);
});

// ================================================================
// VENDOR LOCATION UPDATE (real-time tracking)
// ================================================================
app.post('/api/vendor/update-location', auth, async (req, res) => {
  const { bookingId, latitude, longitude } = req.body;
  if (!bookingId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Booking ID, latitude, and longitude required' });
  }

  const vendorCheck = await pool.query(
    `SELECT v.id FROM vendors v
     JOIN bookings b ON b.vendor_id = v.id
     WHERE b.id = $1 AND v.owner_id = $2`,
    [bookingId, req.userId]
  );
  if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized for this booking' });
  }

  await pool.query(
    `UPDATE vendor_work_status
     SET location_lat = $1, location_lng = $2, location_tracking_active = true
     WHERE booking_id = $3`,
    [latitude, longitude, bookingId]
  );

  res.json({ message: 'Location updated' });
});

// ================================================================
// LATE ARRIVAL PENALTY CHECKER (runs every 10 minutes)
// ================================================================
async function checkLateArrivals() {
  try {
    const result = await pool.query(`
      SELECT 
        b.id AS booking_id,
        b.event_time,
        b.event_date,
        vws.start_time AS actual_start_time,
        vws.vendor_id,
        pr.id AS payment_id,
        pr.amount,
        pr.commission_rate,
        pr.commission_cuts
      FROM bookings b
      JOIN vendor_work_status vws ON b.id = vws.booking_id
      JOIN payment_requests pr ON b.id = pr.booking_id
      WHERE b.event_date = CURRENT_DATE
        AND b.event_time < NOW()::time
        AND vws.status IN ('started', 'working')
        AND pr.status = 'paid'
        AND pr.late_fee_applied = false
    `);

    for (const row of result.rows) {
      const { booking_id, event_time, event_date, vendor_id, payment_id, amount, commission_rate } = row;
      const scheduledDateTime = new Date(`${event_date}T${event_time}:00Z`);
      const now = new Date();
      const latencyMinutes = Math.floor((now - scheduledDateTime) / (1000 * 60));

      if (latencyMinutes <= 30) continue;

      const penaltyMinutes = latencyMinutes - 30;
      const penaltyUnits = Math.floor(penaltyMinutes / 10);
      let totalPenaltyPercent = penaltyUnits * 1.0;
      if (totalPenaltyPercent > 20) totalPenaltyPercent = 20;

      const originalCommission = amount * (commission_rate / 100);
      const penaltyAmount = amount * (totalPenaltyPercent / 100);
      const finalCommission = originalCommission + penaltyAmount;
      const netAmount = amount - finalCommission;

      const cuts = [{
        minute: latencyMinutes,
        percentage: totalPenaltyPercent,
        amount: penaltyAmount,
        reason: 'late arrival',
      }];

      await pool.query(
        `UPDATE payment_requests
         SET commission_cuts = $1,
             final_commission_amount = $2,
             net_amount = $3,
             late_fee_applied = true,
             vendor_arrival_latency_minutes = $4
         WHERE id = $5`,
        [cuts, finalCommission, netAmount, latencyMinutes, payment_id]
      );

      await sendNotification(
        vendor_id,
        'admin',
        'Late Arrival Penalty',
        `Vendor was ${latencyMinutes} minutes late. Cut: ${totalPenaltyPercent.toFixed(2)}% (₹${penaltyAmount.toFixed(2)})`,
        payment_id,
        '/admin/payouts'
      );
    }
  } catch (err) {
    console.error('Error in checkLateArrivals:', err);
  }
}

// ================================================================
// START BACKGROUND JOBS
// ================================================================
setInterval(checkLateArrivals, 10 * 60 * 1000);
checkLateArrivals();

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(`Payment service running on port ${PORT}`));
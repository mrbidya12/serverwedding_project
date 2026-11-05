require('dotenv').config({ path: '../.env' });
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Booking, sequelize } = require('./models/booking');
const auth = require('./middleware/auth');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---------- Broadcast Helper ----------
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://chat-service:30001';

async function broadcastMessage(toUserId, content, type = 'booking', fromUserId = 'system') {
  try {
    await axios.post(`${CHAT_SERVICE_URL}/internal/broadcast`, {
      toUserId, content, type, fromUserId,
    });
  } catch (err) {
    console.error(`Failed to broadcast to user ${toUserId}:`, err.message);
  }
}

// ---------- Helper: Check if user is vendor owner ----------
async function isVendorOwner(userId, vendorId) {
  const [vendor] = await sequelize.query(
    'SELECT id FROM vendors WHERE id = :vendorId AND owner_id = :userId',
    { replacements: { vendorId, userId }, type: sequelize.QueryTypes.SELECT }
  );
  return !!vendor;
}

// ================================================================
// 1. CREATE BOOKING – FULL MANDATORY FORM + UPI AUTO‑FILL
// ================================================================
app.post(
  '/api/bookings',
  auth,
  [
    body('vendor_id').isUUID().withMessage('Valid vendor UUID required'),
    body('event_name').notEmpty().withMessage('Event name is required'),
    body('event_type').notEmpty().withMessage('Event type is required'),
    body('guest_count').isInt({ min: 1 }).withMessage('Guest count must be at least 1'),
    body('budget').isFloat({ min: 0 }).withMessage('Budget must be a positive number'),
    body('event_date').isISO8601().withMessage('Valid event date required'),
    body('event_time').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Event time must be HH:MM'),
    body('event_end_time').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Event end time must be HH:MM'),
    body('venue_location').notEmpty().withMessage('Venue location is required'),
    body('client_upi_id').notEmpty().withMessage('Client UPI ID is required'),
    body('client_upi_name').notEmpty().withMessage('Client UPI name is required'),
    body('special_requests').optional().isString(),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Check vendor exists and is approved
      const [vendor] = await sequelize.query(
        'SELECT id FROM vendors WHERE id = :vendorId AND approved = true',
        { replacements: { vendorId: req.body.vendor_id }, type: sequelize.QueryTypes.SELECT }
      );
      if (!vendor) {
        return res.status(404).json({ error: 'Vendor not found or not approved' });
      }

      // Get client's existing UPI details from users table (for auto‑fill)
      const [user] = await sequelize.query(
        'SELECT upi_id, upi_name FROM users WHERE id = :userId',
        { replacements: { userId: req.userId }, type: sequelize.QueryTypes.SELECT }
      );

      // Use request body values, but if not provided, fallback to user's stored UPI
      const clientUpiId = req.body.client_upi_id || (user ? user.upi_id : '');
      const clientUpiName = req.body.client_upi_name || (user ? user.upi_name : '');

      // If still empty, return error (mandatory)
      if (!clientUpiId || !clientUpiName) {
        return res.status(400).json({
          error: 'Client UPI ID and name are required. Please update your profile or provide them.'
        });
      }

      // Create booking with all fields
      const booking = await Booking.create({
        client_id: req.userId,
        vendor_id: req.body.vendor_id,
        event_name: req.body.event_name,
        event_type: req.body.event_type,
        guest_count: req.body.guest_count,
        budget: req.body.budget,
        event_date: req.body.event_date,
        event_time: req.body.event_time,
        event_end_time: req.body.event_end_time,
        venue_location: req.body.venue_location,
        special_requests: req.body.special_requests || null,
        client_upi_id: clientUpiId,
        client_upi_name: clientUpiName,
        notes: req.body.notes || '',
      });

      // Also update the user's stored UPI if they provided new values (so future bookings auto‑fill)
      if (req.body.client_upi_id && req.body.client_upi_name) {
        await sequelize.query(
          'UPDATE users SET upi_id = :upiId, upi_name = :upiName WHERE id = :userId',
          {
            replacements: {
              upiId: req.body.client_upi_id,
              upiName: req.body.client_upi_name,
              userId: req.userId,
            },
            type: sequelize.QueryTypes.UPDATE,
          }
        );
      }

      res.status(201).json(booking);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ================================================================
// 2. LIST BOOKINGS (client / vendor / admin)
// ================================================================
app.get('/api/bookings', auth, async (req, res) => {
  const where = {};
  try {
    if (req.userRole === 'admin') {
      // Admin sees all
    } else {
      const vendors = await sequelize.query(
        'SELECT id FROM vendors WHERE owner_id = :userId',
        { replacements: { userId: req.userId }, type: sequelize.QueryTypes.SELECT }
      );
      if (vendors && vendors.length > 0) {
        const vendorIds = vendors.map(v => v.id);
        where.vendor_id = vendorIds;
      } else {
        where.client_id = req.userId;
      }
    }

    if (req.query.status) where.status = req.query.status;
    if (req.query.vendor_id) where.vendor_id = req.query.vendor_id;

    const bookings = await Booking.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 3. GET SINGLE BOOKING
// ================================================================
app.get('/api/bookings/:id', auth, async (req, res) => {
  try {
    const booking = await Booking.findByPk(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (req.userRole !== 'admin') {
      const isOwner = booking.client_id === req.userId;
      const isVendor = await isVendorOwner(req.userId, booking.vendor_id);
      if (!isOwner && !isVendor) return res.status(403).json({ error: 'Not authorised' });
    }
    res.json(booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 4. VENDOR CONFIRMS BOOKING
// ================================================================
app.put('/api/bookings/:id/confirm', auth, async (req, res) => {
  try {
    const booking = await Booking.findByPk(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isVendor = await isVendorOwner(req.userId, booking.vendor_id);
    if (!isVendor) return res.status(403).json({ error: 'Only vendor can confirm' });

    if (booking.status !== 'pending') {
      return res.status(400).json({ error: 'Booking already confirmed or cancelled' });
    }

    booking.status = 'confirmed';
    await booking.save();

    await broadcastMessage(booking.client_id, `Booking ${booking.id} confirmed by vendor.`, 'booking');
    res.json({ message: 'Booking confirmed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 5. CLIENT CANCELS BOOKING (with refund rules)
// ================================================================
app.post('/api/bookings/:id/cancel-client', auth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const booking = await Booking.findByPk(id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.client_id !== req.userId) {
      return res.status(403).json({ error: 'Not your booking' });
    }
    if (booking.status === 'completed' || booking.status === 'cancelled') {
      return res.status(400).json({ error: `Booking already ${booking.status}` });
    }

    const eventDate = new Date(booking.event_date);
    const now = new Date();
    const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);

    let refundPercent = 0;
    if (hoursUntilEvent >= 36) {
      refundPercent = 100;
    } else if (hoursUntilEvent >= 24) {
      refundPercent = 50;
    } else {
      refundPercent = 0;
    }

    if (refundPercent === 0) {
      return res.status(400).json({ error: 'No refund available (less than 24 hours before event).' });
    }

    // Get paid amount from payment_requests
    const [payment] = await sequelize.query(
      'SELECT amount FROM payment_requests WHERE booking_id = :bookingId AND status = :status',
      { replacements: { bookingId: id, status: 'paid' }, type: sequelize.QueryTypes.SELECT }
    );
    const paidAmount = payment ? parseFloat(payment.amount) : 0;

    const refundAmount = parseFloat((paidAmount * refundPercent / 100).toFixed(2));

    // Update booking
    booking.status = 'cancelled';
    booking.cancelled_at = new Date();
    booking.cancelled_by = 'client';
    booking.cancel_reason = reason || 'Client cancelled';
    booking.refund_amount = refundAmount;
    await booking.save();

    // Create cancellation request for admin
    await sequelize.query(
      `INSERT INTO cancellation_requests 
       (booking_id, cancelled_by, refund_percent, refund_amount, status)
       VALUES (:bookingId, :cancelledBy, :refundPercent, :refundAmount, 'pending')`,
      {
        replacements: {
          bookingId: id,
          cancelledBy: 'client',
          refundPercent,
          refundAmount,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    // Notify admin
    await broadcastMessage('admin', `Client cancellation request for booking ${id}. Refund: ₹${refundAmount}`, 'admin');
    await broadcastMessage(booking.client_id, `Booking ${id} cancelled. Refund of ₹${refundAmount} requested.`, 'booking');
    res.json({ message: 'Cancellation request submitted', refundAmount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 6. VENDOR CANCELS BOOKING (≥36h before event)
// ================================================================
app.post('/api/bookings/:id/cancel-vendor', auth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const booking = await Booking.findByPk(id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isVendor = await isVendorOwner(req.userId, booking.vendor_id);
    if (!isVendor) return res.status(403).json({ error: 'Not authorized' });
    if (booking.status === 'completed' || booking.status === 'cancelled') {
      return res.status(400).json({ error: `Booking already ${booking.status}` });
    }

    const eventDate = new Date(booking.event_date);
    const now = new Date();
    const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);

    if (hoursUntilEvent < 36) {
      return res.status(400).json({ error: 'Vendor can only cancel 36+ hours before event' });
    }

    // Vendor cancellation: 100% refund to client
    const [payment] = await sequelize.query(
      'SELECT amount FROM payment_requests WHERE booking_id = :bookingId AND status = :status',
      { replacements: { bookingId: id, status: 'paid' }, type: sequelize.QueryTypes.SELECT }
    );
    const paidAmount = payment ? parseFloat(payment.amount) : 0;
    const refundAmount = paidAmount;

    booking.status = 'cancelled';
    booking.cancelled_at = new Date();
    booking.cancelled_by = 'vendor';
    booking.cancel_reason = reason || 'Vendor cancelled';
    booking.refund_amount = refundAmount;
    await booking.save();

    await sequelize.query(
      `INSERT INTO cancellation_requests 
       (booking_id, cancelled_by, refund_percent, refund_amount, status)
       VALUES (:bookingId, :cancelledBy, 100, :refundAmount, 'pending')`,
      {
        replacements: {
          bookingId: id,
          cancelledBy: 'vendor',
          refundAmount,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    await broadcastMessage('admin', `Vendor cancellation for booking ${id}. Full refund ₹${refundAmount}`, 'admin');
    await broadcastMessage(booking.client_id, `Vendor cancelled booking ${id}. Full refund requested.`, 'booking');
    res.json({ message: 'Vendor cancellation submitted', refundAmount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 7. ADMIN: LIST PENDING CANCELLATIONS
// ================================================================
app.get('/api/admin/cancellations/pending', auth, async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });

  try {
    const rows = await sequelize.query(
      `SELECT cr.*, b.event_date, u.email as client_email, v.name as vendor_name
       FROM cancellation_requests cr
       JOIN bookings b ON cr.booking_id = b.id
       JOIN users u ON b.client_id = u.id
       JOIN vendors v ON b.vendor_id = v.id
       WHERE cr.status = 'pending'
       ORDER BY cr.cancelled_at DESC`,
      { type: sequelize.QueryTypes.SELECT }
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 8. ADMIN: PROCESS CANCELLATION (approve/reject)
// ================================================================
app.post('/api/admin/cancellations/:id/process', auth, async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id } = req.params;
  const { action } = req.body; // 'approve' or 'reject'

  try {
    const [cancellation] = await sequelize.query(
      `SELECT * FROM cancellation_requests WHERE id = :id AND status = 'pending'`,
      { replacements: { id }, type: sequelize.QueryTypes.SELECT }
    );
    if (!cancellation) return res.status(404).json({ error: 'Cancellation not found or already processed' });

    if (action === 'approve') {
      await sequelize.query(
        'UPDATE cancellation_requests SET status = :status, processed_at = NOW() WHERE id = :id',
        { replacements: { status: 'approved', id }, type: sequelize.QueryTypes.UPDATE }
      );
      await broadcastMessage(
        cancellation.cancelled_by === 'client' ? cancellation.booking.client_id : 'system',
        `Cancellation request ${id} approved. Refund processing will start.`,
        'admin'
      );
      res.json({ message: 'Cancellation approved' });
    } else if (action === 'reject') {
      await sequelize.query(
        'UPDATE cancellation_requests SET status = :status, processed_at = NOW() WHERE id = :id',
        { replacements: { status: 'rejected', id }, type: sequelize.QueryTypes.UPDATE }
      );
      await broadcastMessage(
        cancellation.cancelled_by === 'client' ? cancellation.booking.client_id : 'system',
        `Cancellation request ${id} rejected.`,
        'admin'
      );
      res.json({ message: 'Cancellation rejected' });
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 9. SERVER START
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Booking service on port ${PORT}`));
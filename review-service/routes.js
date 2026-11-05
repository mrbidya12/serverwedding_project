require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

// ================================================================
// DATABASE CONNECTION
// ================================================================
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'wedding',
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

// ================================================================
// MULTER – FOR IMAGE UPLOADS
// ================================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/reviews';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
const authRequired = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user_id = decoded.user_id;
    req.user_role = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ================================================================
// PLACEHOLDER: Upload to MinIO/S3 (implement as needed)
// ================================================================
async function uploadToStorage(file) {
  // Replace with actual MinIO/S3 upload logic
  // For now, return local path
  return `/uploads/reviews/${file.filename}`;
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'review-service' });
});

// ================================================================
// EXISTING ENDPOINTS (keep your current ones here)
// ================================================================

// ================================================================
// NEW: RATING & FEEDBACK ENDPOINTS
// ================================================================

// POST /api/reviews – Submit feedback with rating, image, text
app.post('/api/reviews', authRequired, upload.single('image'), async (req, res) => {
  const { vendor_id, booking_id, rating, feedback_text } = req.body;
  const client_id = req.user_id;

  // Validate required fields
  if (!vendor_id || !booking_id || !rating) {
    return res.status(400).json({ error: 'vendor_id, booking_id, and rating are required' });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    // 1. Verify booking belongs to client and is completed
    const bookingCheck = await pool.query(
      'SELECT id, vendor_id FROM bookings WHERE id = $1 AND client_id = $2 AND status = $3',
      [booking_id, client_id, 'completed']
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid booking or not completed' });
    }

    // 2. Check existing review
    const existing = await pool.query(
      'SELECT id FROM reviews WHERE booking_id = $1',
      [booking_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Review already submitted for this booking' });
    }

    // 3. Handle image upload
    let image_url = null;
    if (req.file) {
      image_url = await uploadToStorage(req.file);
    }

    // 4. Insert review
    const result = await pool.query(
      `INSERT INTO reviews (client_id, vendor_id, booking_id, rating, feedback_text, image_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [client_id, vendor_id, booking_id, rating, feedback_text || null, image_url]
    );
    const reviewId = result.rows[0].id;

    // 5. Send notification to vendor (optional)
    try {
      const vendorName = (await pool.query(
        'SELECT name FROM users WHERE id = $1',
        [vendor_id]
      )).rows[0]?.name || 'Vendor';

      await axios.post(
        `${process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3006'}/api/notifications/internal`,
        {
          user_id: vendor_id,
          type: 'feedback_received',
          message: `You received a ${rating}-star review from a client`,
          metadata: { review_id: reviewId, rating, vendor_id, client_id }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-internal-key': process.env.INTERNAL_API_KEY || ''
          }
        }
      );
    } catch (err) {
      console.error('Failed to send notification:', err.message);
    }

    res.status(201).json({
      message: 'Review submitted successfully',
      id: reviewId,
      image_url
    });
  } catch (err) {
    console.error('Error submitting review:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// GET /api/reviews/vendor/:vendorId – All feedback for a vendor
app.get('/api/reviews/vendor/:vendorId', async (req, res) => {
  const { vendorId } = req.params;

  try {
    // Get all reviews with client details
    const reviewsResult = await pool.query(
      `SELECT r.*, u.name as client_name, u.profile_picture
       FROM reviews r
       JOIN users u ON r.client_id = u.id
       WHERE r.vendor_id = $1
       ORDER BY r.created_at DESC`,
      [vendorId]
    );

    // Calculate average and count
    const aggResult = await pool.query(
      `SELECT COUNT(*) AS count, COALESCE(AVG(rating)::FLOAT, 0) AS avg_rating
       FROM reviews WHERE vendor_id = $1`,
      [vendorId]
    );

    res.json({
      reviews: reviewsResult.rows,
      averageRating: parseFloat(aggResult.rows[0].avg_rating) || 0,
      reviewCount: parseInt(aggResult.rows[0].count) || 0
    });
  } catch (err) {
    console.error('Error fetching vendor reviews:', err);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// GET /api/reviews/user – Reviews written by logged-in user
app.get('/api/reviews/user', authRequired, async (req, res) => {
  const clientId = req.user_id;

  try {
    const reviews = await pool.query(
      `SELECT r.*, v.name as vendor_name, v.category
       FROM reviews r
       JOIN vendors v ON r.vendor_id = v.id
       WHERE r.client_id = $1
       ORDER BY r.created_at DESC`,
      [clientId]
    );
    res.json(reviews.rows);
  } catch (err) {
    console.error('Error fetching user reviews:', err);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 8083;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Review service running on port ${PORT}`);
});
// ================================================================
//  ADD TO vendor-service/server.js
// ================================================================

// GET /api/vendors/dashboard – Full dashboard for vendor
app.get('/api/vendors/dashboard', authRequired, async (req, res) => {
  const vendorId = req.user_id;

  const stats = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM bookings WHERE vendor_id = $1) AS total_bookings,
      (SELECT COUNT(*) FROM bookings WHERE vendor_id = $1 AND status = 'approved') AS approved_bookings,
      (SELECT COUNT(*) FROM bookings WHERE vendor_id = $1 AND status = 'completed') AS completed_bookings,
      (SELECT COUNT(*) FROM bookings WHERE vendor_id = $1 AND status = 'requested') AS requested_bookings,
      (SELECT COUNT(*) FROM reviews WHERE vendor_id = $1) AS total_reviews,
      (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE vendor_id = $1) AS avg_rating,
      (SELECT COUNT(CASE WHEN rating >= 4 THEN 1 END)::FLOAT / NULLIF(COUNT(*), 0) * 100
       FROM reviews WHERE vendor_id = $1) AS good_feedback_percentage,
      get_vendor_priority($1) AS priority,
      (SELECT profile_views FROM vendors WHERE id = $1) AS profile_views,
      (SELECT COUNT(*) FROM reports WHERE vendor_id = $1) AS reports_count,
      (SELECT COUNT(*) FROM payment_requests WHERE vendor_id = $1 AND payout_status = 'pending') AS pending_payouts,
      (SELECT COUNT(*) FROM payment_requests WHERE vendor_id = $1 AND payout_status = 'done') AS done_payouts,
      (SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false) AS unread_notifications
  `, [vendorId]);

  res.json(stats.rows[0]);
});

// PUT /api/vendors/profile – Update profile with photo upload
app.put('/api/vendors/profile', authRequired, upload.single('photo'), async (req, res) => {
  const vendorId = req.user_id;
  const { name, category, description, address, phone, upi_id } = req.body;

  let photo_url = null;
  if (req.file) {
    // photo_url = await uploadToStorage(req.file);
    photo_url = 'uploads/' + req.file.filename;
  }

  await pool.query(
    `UPDATE vendors SET
      name = COALESCE($1, name),
      category = COALESCE($2, category),
      description = COALESCE($3, description),
      address = COALESCE($4, address),
      phone = COALESCE($5, phone),
      upi_id = COALESCE($6, upi_id),
      photo_url = COALESCE($7, photo_url)
    WHERE id = $8`,
    [name, category, description, address, phone, upi_id, photo_url, vendorId]
  );

  res.json({ message: 'Profile updated successfully' });
});

// GET /api/vendors – Sorted by priority (High > Moderate > Low) and rating
app.get('/api/vendors', async (req, res) => {
  const { category, city, search } = req.query;
  let query = `
    SELECT v.*,
      (SELECT COUNT(*) FROM reviews WHERE vendor_id = v.id) AS review_count,
      (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE vendor_id = v.id) AS avg_rating,
      v.priority_level
    FROM vendors v
    WHERE v.approved = true
  `;
  const params = [];
  if (category) {
    query += ' AND v.category = $' + (params.length + 1);
    params.push(category);
  }
  if (city) {
    query += ' AND v.city = $' + (params.length + 1);
    params.push(city);
  }
  if (search) {
    query += ' AND v.name ILIKE $' + (params.length + 1);
    params.push('%' + search + '%');
  }
  query += `
    ORDER BY
      CASE v.priority_level
        WHEN 'High' THEN 1
        WHEN 'Moderate' THEN 2
        WHEN 'Low' THEN 3
      END,
      avg_rating DESC,
      review_count DESC
  `;
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// GET /api/vendors/:vendorId – Increment view count and return vendor
app.get('/api/vendors/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId;
  const vendor = await pool.query('SELECT * FROM vendors WHERE id = $1', [vendorId]);
  if (vendor.rows.length === 0) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  // Asynchronously increment view count
  pool.query('UPDATE vendors SET profile_views = profile_views + 1 WHERE id = $1', [vendorId]);
  res.json(vendor.rows[0]);
});

require('dotenv').config({ path: '../.env' });
const express = require('express');
const { body, validationResult } = require('express-validator');
const { Complaint } = require('./models/complaint');

const app = express();
app.use(express.json());

// All routes are under /api/complaints (already prefixed by gateway)

// File a complaint (any authenticated user)
app.post('/',
  [
    body('respondent_id').isUUID(),
    body('reason').notEmpty(),
  ],
  async (req, res) => {
    if (!req.headers['x-user-id']) return res.status(401).json({ error: 'Unauthorized' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const complaint = await Complaint.create({
        complainant_id: req.headers['x-user-id'],
        respondent_id: req.body.respondent_id,
        reason: req.body.reason,
      });
      res.status(201).json(complaint);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Get complaints – admin sees all, users see only their own
app.get('/', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const where = {};
  if (role !== 'admin') {
    where.complainant_id = userId;
  }
  if (req.query.status) where.status = req.query.status;

  try {
    const complaints = await Complaint.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(complaints);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve complaint (admin only)
app.put('/:id/resolve',
  async (req, res) => {
    if (req.headers['x-user-role'] !== 'admin') return res.status(403).json({ error: 'Admin only' });

    try {
      const complaint = await Complaint.findByPk(req.params.id);
      if (!complaint) return res.status(404).json({ error: 'Not found' });
      complaint.status = 'resolved';
      complaint.resolution_note = req.body.note || '';
      complaint.resolved_at = new Date();
      await complaint.save();
      res.json(complaint);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Complaint service on port ${PORT}`));
const { Sequelize, DataTypes } = require('sequelize');

// ---------- Database Connection ----------
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/wedding', {
  logging: false,
});

// ---------- Booking Model ----------
const Booking = sequelize.define('Booking', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  client_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  vendor_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },

  // ===== MANDATORY BOOKING FORM FIELDS =====
  event_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  event_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  guest_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  budget: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  event_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  event_time: {
    type: DataTypes.TIME,
    allowNull: false,
  },
  event_end_time: {
    type: DataTypes.TIME,
    allowNull: false,
  },
  venue_location: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  special_requests: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // ===== CLIENT UPI DETAILS (auto‑filled, but editable) =====
  client_upi_id: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  client_upi_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },

  total_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show'),
    defaultValue: 'pending',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },

  // ---------- Cancellation fields ----------
  cancelled_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  cancelled_by: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  cancel_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  refund_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
}, {
  tableName: 'bookings',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = { Booking, sequelize };
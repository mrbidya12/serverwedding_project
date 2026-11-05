const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/wedding', {
  logging: false,
});

// ---------- Models ----------
const Block = sequelize.define('Block', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  blocker_id: { type: DataTypes.UUID, allowNull: false },
  blocked_id: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'blocked_users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [{ unique: true, fields: ['blocker_id', 'blocked_id'] }],
});

const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  sender_id: { type: DataTypes.UUID, allowNull: false },
  receiver_id: { type: DataTypes.UUID, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'messages',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

const Report = sequelize.define('Report', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  reporter_id: { type: DataTypes.UUID, allowNull: false },
  vendor_id: { type: DataTypes.UUID, allowNull: false },
  booking_id: { type: DataTypes.UUID, allowNull: true },
  event_name: { type: DataTypes.STRING, allowNull: false },
  event_date: { type: DataTypes.DATEONLY, allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: false },
  photo_urls: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  status: {
    type: DataTypes.ENUM('pending', 'reviewing', 'resolved', 'dismissed'),
    defaultValue: 'pending',
  },
  admin_notes: { type: DataTypes.TEXT, allowNull: true },
  resolved_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

// ✅ FIX: report_id is now nullable (allowNull: true) so admin block can work without a report
const BlockChat = sequelize.define('BlockChat', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  report_id: { type: DataTypes.UUID, allowNull: true },   // ✅ Changed from false to true
  from_user_id: { type: DataTypes.UUID, allowNull: false },
  to_user_id: { type: DataTypes.UUID, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  is_admin: { type: DataTypes.BOOLEAN, defaultValue: false },
  read_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'block_chats',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = { sequelize, Block, Message, Report, BlockChat };
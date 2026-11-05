const { io } = require('socket.io-client');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFkbWluQHRlc3QuY29tIiwiZXhwIjoxNzgyMDE1MDk5LCJyb2xlIjoiYWRtaW4iLCJ1c2VyX2lkIjoiZmY2Mzc0OGEtMGExMS00NjFmLTkzYjUtYWM5OTM1YWQ1NDRhIn0.uZG5eBwaqrNMu8nbbOaVHgX-893iMo1hOuWfOhzfuoc';
const vendorUserId = '750f2c5c-89c4-4913-a762-da340511e8be';
const vendorId = '3d182d7b-9322-43cc-9558-afbee799b915';

const socket = io('ws://localhost:30000', { auth: { token } });

socket.on('connect', () => {
  console.log('Connected as admin');
  // Send a message to the vendor
  socket.emit('send_message', {
    toUserId: vendorUserId,
    vendorId: vendorId,
    content: 'Hello vendor, this is admin.'
  });
  // Block the vendor
  socket.emit('block_user', { userIdToBlock: vendorUserId });
});

socket.on('receive_message', (msg) => console.log('Received:', msg));
socket.on('admin_receive_message', (msg) => console.log('Admin monitor:', msg));
socket.on('message_sent', (msg) => console.log('Sent:', msg));
socket.on('user_blocked', (userId) => console.log('Blocked:', userId));
socket.on('error', (err) => console.log('Error:', err));
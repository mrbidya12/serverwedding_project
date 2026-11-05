const io = require('socket.io-client');

const token = process.argv[2];
const toUserId = process.argv[3];
const content = process.argv[4] || 'Hello from test!';

const socket = io('http://localhost:4000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('connect', () => {
    console.log('✅ Client connected!');
    socket.emit('send_message', { toUserId, content, type: 'text' });
});

socket.on('message_sent', (data) => console.log('📤 Message sent:', data));
socket.on('connect_error', (err) => console.error('❌ Error:', err.message));

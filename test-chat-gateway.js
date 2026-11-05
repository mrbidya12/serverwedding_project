const io = require('socket.io-client');

const token = process.argv[2];
const toUserId = process.argv[3] || 'bbe65dbe-bf0a-4d1f-8301-43b3d94f2e4c';
const content = process.argv[4] || 'Hello from test!';

const socket = io('http://localhost:4000', {   // ✅ Base URL only
    path: '/api/chat',                         // ✅ Path separate
    transports: ['websocket'],
    auth: { token }
});

socket.on('connect', () => {
    console.log('✅ Connected via gateway!');
    socket.emit('send_message', { toUserId, content, type: 'text' });
});

socket.on('message_sent', (data) => console.log('📤 Message sent:', data));
socket.on('receive_message', (data) => console.log('📩 Received:', data));
socket.on('connect_error', (err) => console.error('❌ Error:', err.message));

const io = require('socket.io-client');
const token = process.argv[2];

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('receive_message', (data) => {
    console.log('📩 Vendor received:', data.content);
});

socket.on('connect', () => {
    console.log('✅ Vendor listening...');
});

socket.on('connect_error', (err) => {
    console.error('❌ Error:', err.message);
});

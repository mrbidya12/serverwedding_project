const io = require('socket.io-client');

const token = process.argv[2];

const socket = io('http://localhost:4000/api/chat', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('receive_message', (data) => {
    console.log('📩 Vendor received:', data);
});

socket.on('connect', () => console.log('✅ Vendor listening via gateway...'));
socket.on('connect_error', (err) => console.error('❌ Error:', err.message));

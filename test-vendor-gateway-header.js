const io = require('socket.io-client');

const token = process.argv[2];

const socket = io('http://localhost:4000', {
    path: '/api/chat',
    transports: ['websocket'],
    extraHeaders: {
        Authorization: 'Bearer ' + token
    }
});

socket.on('receive_message', (data) => {
    console.log('📩 Vendor received:', data);
});

socket.on('connect', () => console.log('✅ Vendor connected!'));
socket.on('connect_error', (err) => console.error('❌ Error:', err.message));

const io = require('socket.io-client');

const token = process.argv[2];

const socket = io('http://localhost:4000', {
    path: '/api/chat',
    transports: ['websocket'],
    extraHeaders: {
        Authorization: 'Bearer ' + token
    }
});

socket.on('connect', () => {
    console.log('✅ Connected, listening for notifications...');
});

socket.on('new_notification', (data) => {
    console.log('🔔 Notification received:', data);
});

socket.on('connect_error', (err) => {
    console.error('❌ Error:', err.message);
});

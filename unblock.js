const io = require('socket.io-client');
const token = process.argv[2];
const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('connect', () => {
    socket.emit('user_unblock', { userIdToUnblock: process.argv[3] });
});

socket.on('unblocked_user', (data) => {
    console.log('✅ Unblocked:', data);
    socket.disconnect();
    process.exit(0);
});

socket.on('error', (err) => {
    console.error('❌ Error:', err);
    socket.disconnect();
    process.exit(1);
});

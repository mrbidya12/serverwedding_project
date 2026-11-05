const io = require('socket.io-client');

const token = process.argv[2];
const ciphertext = process.argv[3] || 'Hello from test!';

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }  // <-- CORRECT: token goes in auth, not extraHeaders
});

socket.on('connect', () => {
    console.log('✅ Connected to chat-service!');
    socket.emit('send_message', {
        toUserId: 'bbe65dbe-bf0a-4d1f-8301-43b3d94f2e4c',
        content: ciphertext,
        type: 'text'
    });
});

socket.on('message', (data) => console.log('📩 Received:', data));
socket.on('connect_error', (err) => console.error('❌ Error:', err.message));

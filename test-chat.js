const io = require('socket.io-client');

// ================================================================
// DEBUG: Print all arguments to see what we're receiving
// ================================================================
console.log('🔍 Received arguments:', process.argv.slice(2));

const token = process.argv[2];
const toUserId = process.argv[3];
const content = process.argv[4] || 'Hello from test!';

console.log('🔍 Token:', token ? token.substring(0, 20) + '...' : 'null');
console.log('🔍 toUserId:', toUserId);
console.log('🔍 content:', content ? content.substring(0, 30) + '...' : 'null');

if (!token || !toUserId) {
    console.error('❌ Usage: node test-chat.js <token> <toUserId> [content]');
    process.exit(1);
}

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('connect', () => {
    console.log('✅ Connected to chat-service!');
    socket.emit('send_message', { toUserId, content, type: 'text' });
});

socket.on('message_sent', (data) => {
    console.log('📤 Message sent:', data);
    socket.disconnect();
    process.exit(0);
});

socket.on('receive_message', (data) => {
    console.log('📩 Received:', data);
    // Don't exit here – keep listening if needed
});

socket.on('error', (err) => {
    console.error('❌ Error:', err);
    socket.disconnect();
    process.exit(1);
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
});

const { createServer } = require('http');
const { Server } = require('socket.io');

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RetroIM Server is running');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3333;

// ── State ──────────────────────────────
const users = new Map();  // socketId → User
const rooms = new Map();  // roomName → Room

const DEFAULT_ROOMS = ['General', 'Music', 'Gaming', 'Sports', 'Off Topic'];
DEFAULT_ROOMS.forEach(name =>
  rooms.set(name, { name, topic: `Welcome to #${name}`, members: new Set(), messages: [] })
);

// ── Helpers ────────────────────────────
const getUser = id => users.get(id);
const usernameTaken = name =>
  Array.from(users.values()).some(u => u.username.toLowerCase() === name.toLowerCase());

const publicUser = u => ({ id: u.id, username: u.username, status: u.status, statusMsg: u.statusMsg, avatar: u.avatar });
const publicRoom = ([name, r]) => ({ name, topic: r.topic, members: r.members.size });

const broadcastUsers = () => io.emit('user_list', Array.from(users.values()).map(publicUser));
const broadcastRooms = () => io.emit('room_list', Array.from(rooms.entries()).map(publicRoom));

function roomMembers(roomName) {
  const r = rooms.get(roomName);
  if (!r) return [];
  return Array.from(r.members).map(id => users.get(id)).filter(Boolean).map(publicUser);
}

// ── Socket Handlers ────────────────────
io.on('connection', socket => {

  socket.on('login', ({ username, status, statusMsg, avatar }) => {
    const name = (username || '').trim().slice(0, 32);
    if (!name) return socket.emit('login_error', 'Screen name required.');
    if (usernameTaken(name)) return socket.emit('login_error', 'That screen name is already in use.');

    users.set(socket.id, {
      id: socket.id,
      username: name,
      status: status || 'online',
      statusMsg: (statusMsg || '').slice(0, 80),
      avatar: avatar || '1',
      joinedRooms: new Set()
    });

    socket.emit('login_success', {
      id: socket.id,
      username: name,
      userList: Array.from(users.values()).map(publicUser),
      roomList: Array.from(rooms.entries()).map(publicRoom)
    });

    broadcastUsers();
    io.emit('system', { text: `${name} signed in`, type: 'join' });
  });

  socket.on('update_status', ({ status, statusMsg }) => {
    const u = getUser(socket.id);
    if (!u) return;
    if (status) u.status = status;
    if (statusMsg !== undefined) u.statusMsg = statusMsg.slice(0, 80);
    broadcastUsers();
  });

  socket.on('get_lists', () => {
    socket.emit('user_list', Array.from(users.values()).map(publicUser));
    socket.emit('room_list', Array.from(rooms.entries()).map(publicRoom));
  });

  // ── Rooms ────────────────────────────
  socket.on('create_room', ({ name, topic }) => {
    const roomName = (name || '').trim().slice(0, 40);
    if (!roomName) return socket.emit('room_error', 'Room name required.');
    if (rooms.has(roomName)) return socket.emit('room_error', `Room "${roomName}" already exists.`);
    rooms.set(roomName, { name: roomName, topic: (topic || '').slice(0, 100), members: new Set(), messages: [] });
    broadcastRooms();
    socket.emit('room_created', roomName);
  });

  socket.on('join_room', roomName => {
    const room = rooms.get(roomName);
    const u = getUser(socket.id);
    if (!room || !u) return;
    if (room.members.has(socket.id)) return;

    socket.join(`room:${roomName}`);
    room.members.add(socket.id);
    u.joinedRooms.add(roomName);

    socket.emit('room_history', { roomName, messages: room.messages.slice(-100) });
    io.to(`room:${roomName}`).emit('room_members', { roomName, members: roomMembers(roomName) });
    socket.to(`room:${roomName}`).emit('room_event', { roomName, text: `${u.username} entered the room`, type: 'join' });
    broadcastRooms();
  });

  socket.on('leave_room', roomName => {
    const room = rooms.get(roomName);
    const u = getUser(socket.id);
    socket.leave(`room:${roomName}`);
    if (room) {
      room.members.delete(socket.id);
      if (u) socket.to(`room:${roomName}`).emit('room_event', { roomName, text: `${u.username} left the room`, type: 'leave' });
      io.to(`room:${roomName}`).emit('room_members', { roomName, members: roomMembers(roomName) });
      if (room.members.size === 0 && !DEFAULT_ROOMS.includes(roomName)) rooms.delete(roomName);
    }
    if (u) u.joinedRooms.delete(roomName);
    broadcastRooms();
  });

  socket.on('room_message', ({ roomName, text }) => {
    const u = getUser(socket.id);
    if (!u || !rooms.get(roomName) || !text.trim()) return;
    const msg = { roomName, fromId: socket.id, fromUsername: u.username, fromAvatar: u.avatar, text: text.slice(0, 1000), ts: Date.now() };
    const room = rooms.get(roomName);
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(`room:${roomName}`).emit('room_message', msg);
  });

  socket.on('room_typing', ({ roomName, isTyping }) => {
    const u = getUser(socket.id);
    if (!u) return;
    socket.to(`room:${roomName}`).emit('room_typing', { roomName, fromId: socket.id, fromUsername: u.username, isTyping });
  });

  // ── Private Messages ─────────────────
  socket.on('private_message', ({ toId, text }) => {
    const sender = getUser(socket.id);
    const recipient = getUser(toId);
    if (!sender || !recipient || !text.trim()) return;
    const msg = { fromId: socket.id, fromUsername: sender.username, fromAvatar: sender.avatar, toId, toUsername: recipient.username, text: text.slice(0, 1000), ts: Date.now() };
    socket.emit('private_message', msg);
    io.to(toId).emit('private_message', msg);
  });

  socket.on('typing', ({ toId, isTyping }) => {
    const u = getUser(socket.id);
    if (!u) return;
    io.to(toId).emit('typing', { fromId: socket.id, fromUsername: u.username, isTyping });
  });

  // ── Disconnect ────────────────────────
  socket.on('disconnect', () => {
    const u = getUser(socket.id);
    if (!u) return;
    u.joinedRooms.forEach(roomName => {
      const room = rooms.get(roomName);
      if (!room) return;
      room.members.delete(socket.id);
      io.to(`room:${roomName}`).emit('room_members', { roomName, members: roomMembers(roomName) });
      io.to(`room:${roomName}`).emit('room_event', { roomName, text: `${u.username} left the room`, type: 'leave' });
      if (room.members.size === 0 && !DEFAULT_ROOMS.includes(roomName)) rooms.delete(roomName);
    });
    users.delete(socket.id);
    broadcastUsers();
    broadcastRooms();
    io.emit('system', { text: `${u.username} signed out`, type: 'leave' });
  });
});

httpServer.listen(PORT, () => {
  console.log(`RetroIM server running on port ${PORT}`);
  console.log(`Default rooms: ${DEFAULT_ROOMS.join(', ')}`);
});

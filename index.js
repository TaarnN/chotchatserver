import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    preflightContinue: true,
  },
});

const rooms = {};
const MAX_USERS_PER_ROOM = 40;

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.onAny((event, ...args) => {
    console.log(`📥 Event from ${socket.id}:`, event, args);
  });

  socket.on("join room", ({ username, roomId }) => {
    const cleanRoom = typeof roomId === "string" ? roomId.trim() : "";
    const cleanUsername =
      typeof username === "string" ? username.trim().substring(0, 20) : "";

    if (!cleanRoom) {
      socket.emit("room error", "Invalid room ID");
      return;
    }
    if (!cleanUsername) {
      socket.emit("username error", "Invalid username");
      return;
    }

    if (!rooms[cleanRoom]) {
      rooms[cleanRoom] = { users: {}, usernames: new Set() };
    }
    const room = rooms[cleanRoom];

    if (Object.keys(room.users).length >= MAX_USERS_PER_ROOM) {
      socket.emit("room full");
      return;
    }

    if (room.usernames.has(cleanUsername)) {
      socket.emit("username error", "Username is taken in this room");
      return;
    }

    room.users[socket.id] = { id: socket.id, username: cleanUsername };
    room.usernames.add(cleanUsername);
    socket.join(cleanRoom);

    socket.emit("username set", cleanUsername);
    socket.emit("room set", cleanRoom);

    io.to(cleanRoom).emit("user count", Object.keys(room.users).length);
    io.to(cleanRoom).emit("user joined", cleanUsername);
  });

  socket.on("chat message", (content) => {
    const roomId = Array.from(socket.rooms).find((rid) => rid !== socket.id);
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    const user = room.users[socket.id];
    if (!user) return;
    if (typeof content !== "string" || !content.trim()) return;

    const payload = {
      id: `${socket.id}-${Date.now()}`,
      content: content.trim(),
      senderId: socket.id,
      username: user.username,
    };
    io.to(roomId).emit("chat message", payload);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const user = room.users[socket.id];
      if (user) {
        const { username } = user;
        delete room.users[socket.id];
        room.usernames.delete(username);
        socket.leave(roomId);

        io.to(roomId).emit("user count", Object.keys(room.users).length);
        io.to(roomId).emit("user left", username);

        if (Object.keys(room.users).length === 0) {
          delete rooms[roomId];
        }
        break;
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

server.listen(process.env.PORT || 3001);

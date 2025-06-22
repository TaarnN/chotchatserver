import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";
import { URL } from "url";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://chotchat.vercel.app",
    methods: ["GET", "POST"],
    preflightContinue: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    allowReconnection: true,
  },
});

const rooms = new Map();
const MAX_USERS_PER_ROOM = 40;
const isProduction = process.env.NODE_ENV === "production";

io.on("connection", (socket) => {
  if (!isProduction) console.log("✅ User connected:", socket.id);

  if (!isProduction) {
    socket.onAny((event, ...args) => {
      console.log(`📥 Event from ${socket.id}:`, event, args);
    });
  }

  socket.on("join room", ({ username, roomId }) => {
    const cleanRoom = typeof roomId === "string" ? roomId.trim() : "";
    const cleanUsername =
      typeof username === "string" ? username.trim().substring(0, 20) : "";

    if (!cleanRoom) return socket.emit("room error", "Invalid room ID");
    if (!cleanUsername)
      return socket.emit("username error", "Invalid username");

    if (socket.data.roomId) {
      const prevRoomId = socket.data.roomId;
      const prevRoom = rooms.get(prevRoomId);

      if (prevRoom) {
        prevRoom.users.delete(socket.id);
        prevRoom.usernames.delete(socket.data.username);

        if (prevRoom.users.size === 0) {
          rooms.delete(prevRoomId);
        } else {
          io.to(prevRoomId).emit("user count", prevRoom.users.size);
          io.to(prevRoomId).emit("user left", socket.data.username);
          io.to(prevRoomId).emit("room users", Array.from(prevRoom.usernames));
        }

        socket.leave(prevRoomId);
      }
    }

    let room = rooms.get(cleanRoom);
    if (!room) {
      room = {
        users: new Map(),
        usernames: new Set(),
      };
      rooms.set(cleanRoom, room);
    }

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      return socket.emit("room full");
    }

    if (room.usernames.has(cleanUsername)) {
      return socket.emit("username error", "Username is taken in this room");
    }

    room.users.set(socket.id, { id: socket.id, username: cleanUsername });
    room.usernames.add(cleanUsername);
    socket.join(cleanRoom);

    socket.data.roomId = cleanRoom;
    socket.data.username = cleanUsername;

    socket.emit("username set", cleanUsername);
    socket.emit("room set", cleanRoom);

    io.to(cleanRoom).emit("user count", room.users.size);
    io.to(cleanRoom).emit("user joined", cleanUsername);
    io.to(cleanRoom).emit("room users", Array.from(room.usernames));
  });

  socket.on("AI request", async (messages) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    if (!Array.isArray(messages)) {
      return socket.emit("AI error", "Invalid messages format");
    }

    const historyParams = [];
    const maxEntries = 10;

    messages.slice(-maxEntries).forEach((msg) => {
      if (
        !msg ||
        typeof msg.username !== "string" ||
        typeof msg.content !== "string"
      )
        return;

      let entry = `(${msg.username})${msg.content}`;
      if (entry.length > 1000) {
        entry = entry.substring(0, 1000);
      }
      historyParams.push(entry);
    });

    const controller = new AbortController();
    let timeout;
    io.to(roomId).emit("typing", "AI");
    try {
      const url = new URL("https://ttaarrnn-chotchataispace.hf.space/chat");
      historyParams.forEach((entry) => {
        url.searchParams.append("h", entry);
      });
      console.log("URL: ", url.toString());

      timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const aiReply = data.reply || "";

      const payload = {
        id: `AI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: aiReply,
        senderId: "AI",
        username: "AI",
      };

      io.to(roomId).emit("chat message", payload);
    } catch (err) {
      clearTimeout(timeout);
      console.error("AI request failed:", err);
      socket.emit("AI error", "Failed to get AI response");
    } finally {
      io.to(roomId).emit("stop typing", "AI");
    }
  });

  socket.on("typing", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (roomId && username) {
      io.to(roomId).emit("typing", username);
    }
  });

  socket.on("stop typing", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (roomId && username) {
      io.to(roomId).emit("stop typing", username);
    }
  });

  socket.on("chat message", (content) => {
    if (typeof content !== "string" || !content.trim()) return;

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const payload = {
      id: `${socket.id}-${Date.now()}`,
      content: content.trim(),
      senderId: socket.id,
      username: user.username,
    };

    io.to(roomId).emit("chat message", payload);
  });

  socket.on("edit message", ({ messageId, newContent }) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      io.to(roomId).emit("message edited", { messageId, newContent });
    }
  });

  socket.on("delete message", ({ messageId }) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      io.to(roomId).emit("message deleted", { messageId });
    }
  });

  socket.on("link preview", async ({ url, tempId }) => {
    try {
      const res = await fetch(url);
      const html = await res.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : url;
      socket.emit("link preview", { tempId, preview: { url, title } });
    } catch (err) {
      socket.emit("link preview", { tempId, preview: { url, title: url } });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const username = socket.data.username;
    room.users.delete(socket.id);
    room.usernames.delete(username);

    if (room.users.size === 0) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit("user count", room.users.size);
      io.to(roomId).emit("user left", username);
      io.to(roomId).emit("room users", Array.from(room.usernames));
    }

    if (!isProduction) console.log("User disconnected:", socket.id);
  });

  socket.on("error", (err) => {
    if (!isProduction) console.error("Socket error:", err);
  });
});

server.listen(process.env.PORT || 3001);

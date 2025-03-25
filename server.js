import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.js";
import roomRoutes from "./routes/room.js";
import messageRoutes from "./routes/message.js";
import Room from "./models/Room.js";
import User from "./models/User.js";
import Message from "./models/Message.js";
import ExpressFormidable from "express-formidable";
import cloudinary from "cloudinary";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(ExpressFormidable());

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => console.error("❌ MongoDB Connection Failed:", err));

app.use("/api/auth", authRoutes);
app.use("/api/room", roomRoutes);
app.use("/api/message", messageRoutes);

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_USER_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post("/upload-profile-photo/:id", ExpressFormidable(), async (req, res) => {
    console.log(req.files.photo);
    try {
        if (!req.files || !req.params) {
            return res.status(400).json({ error: "All Fields Are Required" });
        }

        const result = await cloudinary.uploader.upload(req.files.photo.path, {
            folder: "profile_photos_watch_party",
            transformation: [{ width: 500, height: 500, crop: "limit" }],
        });

        const user = await User.findOneAndUpdate(
            { _id: req.params?.id },
            { profilePic: result.secure_url },
            { new: true }
        );

        if (!user) {
            res.status(404).send({ success: false, message: "User Not Found" });
        }

        res.status(200).json({
            message: "Profile photo uploaded successfully",
            imageUrl: result.secure_url,
            updatedUser: user,
        });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Failed to upload profile photo" });
    }
});

const rooms = {};

// Helper function to fetch room details
const fetchRoomDetails = async (roomId) => {
    try {
        const room = await Room.findById(roomId);
        if (!room) {
            throw new Error("Room not found");
        }

        const participants = await Promise.all(
            rooms[roomId].participants.map(async (id) => {
                const user = await User.findById(id).select("username profilePic");
                return {
                    id,
                    username: user?.username || "Unknown User",
                    profilePic: user?.profilePic || null,
                };
            })
        );

        return {
            adminName: room.adminName,
            participants,
            activeUsersCount: participants.length,
        };
    } catch (error) {
        console.error("Error fetching room details:", error);
        return null;
    }
};

io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    socket.on("create-room", async ({ userId, userName }) => {
        try {
            const room = new Room({
                name: `Room-${Date.now()}`,
                admin: userId,
                users: [userId],
                adminName: userName,
            });

            await room.save();

            rooms[room._id.toString()] = {
                admin: userId,
                videoUrl: "",
                serviceId: "1", // Default to YouTube (id: "1")
                participants: [userId],
            };

            socket.join(room._id.toString());

            io.to(room._id.toString()).emit("room-created", {
                roomId: room._id.toString(),
                adminId: room.admin,
                users: room.users,
                adminName: room.adminName,
            });

            console.log(`🚀 Room created: ${room._id}, Admin: ${room.admin}`);

            // Emit initial room details
            const roomDetails = await fetchRoomDetails(room._id.toString());
            io.to(room._id.toString()).emit("room-details", roomDetails);
        } catch (error) {
            console.error("❌ Room creation failed:", error);
            socket.emit("room-error", "Failed to create room.");
        }
    });

    socket.on("join-room", async ({ roomId, userId, adminName }) => {
        console.log(`🔹 Join request received for Room ID: ${roomId}`);

        if (!roomId || !rooms[roomId]) {
            console.log(`❌ Room ${roomId} does not exist.`);
            socket.emit("room-error", "Room does not exist.");
            return;
        }

        socket.join(roomId);

        if (!rooms[roomId].participants.includes(userId)) {
            rooms[roomId].participants.push(userId);
        }

        socket.emit("room-joined", {
            roomId,
            adminId: rooms[roomId].admin,
            videoUrl: rooms[roomId].videoUrl,
            serviceId: rooms[roomId].serviceId,
            participants: rooms[roomId].participants,
            adminName: rooms[roomId].adminName || adminName,
        });

        console.log(`✅ User ${userId} joined room ${roomId} created by ${adminName}`);
        io.to(roomId).emit("update-participants", {
            participants: rooms[roomId].participants,
        });

        // Emit updated room details to all participants
        const roomDetails = await fetchRoomDetails(roomId);
        if (roomDetails) {
            io.to(roomId).emit("room-details", roomDetails);
        } else {
            socket.emit("room-error", "Failed to fetch room details.");
        }
    });

    socket.on("get-room-details", async ({ roomId }) => {
        if (!roomId || !rooms[roomId]) {
            socket.emit("room-error", "Room does not exist.");
            return;
        }

        const roomDetails = await fetchRoomDetails(roomId);
        if (roomDetails) {
            socket.emit("room-details", roomDetails);
        } else {
            socket.emit("room-error", "Failed to fetch room details.");
        }
    });

    socket.on("play-video", async ({ roomId, url, serviceId, adminId }) => {
        console.log("🎥 Play video request received:", url, "Service ID:", serviceId);

        if (rooms[roomId]?.admin === adminId) {
            console.log(`✅ Admin authorized. Broadcasting video to room: ${roomId}`);

            rooms[roomId].videoUrl = url;
            rooms[roomId].serviceId = serviceId;

            io.in(roomId).emit("load-video", { url, serviceId });
        } else {
            console.log(`❌ Unauthorized attempt by ${adminId}`);
        }
    });

    socket.on("pause-video", ({ roomId, time, adminId }) => {
        if (rooms[roomId]?.admin === adminId) {
            console.log(`⏸️ Pause video at ${time}s for room ${roomId}`);
            io.to(roomId).emit("pause-video", { time });
        } else {
            console.log(`❌ Unauthorized pause attempt by ${adminId}`);
        }
    });

    socket.on("resume-video", ({ roomId, time, adminId }) => {
        if (rooms[roomId]?.admin === adminId) {
            console.log(`▶️ Resume video at ${time}s for room ${roomId}`);
            io.to(roomId).emit("resume-video", { time });
        } else {
            console.log(`❌ Unauthorized resume attempt by ${adminId}`);
        }
    });

    socket.on("seek-video", ({ roomId, time, adminId }) => {
        if (rooms[roomId]?.admin === adminId) {
            console.log(`⏩ Seek video to ${time}s for room ${roomId}`);
            io.to(roomId).emit("seek-video", { time });
        } else {
            console.log(`❌ Unauthorized seek attempt by ${adminId}`);
        }
    });

    socket.on("sync-video", ({ roomId, time, playing, adminId }) => {
        if (rooms[roomId]?.admin === adminId) {
            console.log(`🔄 Sync video to ${time}s (playing: ${playing}) for room ${roomId}`);
            io.to(roomId).emit("sync-video", { time, playing });
        } else {
            console.log(`❌ Unauthorized sync attempt by ${adminId}`);
        }
    });

    socket.on("send-message", async ({ roomId, msg, userId }) => {
        console.log(`💬 Message received in room ${roomId}: ${msg.text}`);
        try {
            const user = await User.findById(userId);
            if (user) {
                const newMessage = new Message({
                    room: roomId,
                    senderId: userId,
                    text: msg.text,
                    sender: user,
                });
                await newMessage.save();
                io.to(roomId).emit("receive-message", newMessage);
            }
        } catch (error) {
            console.error("❌ Message saving failed:", error);
        }
    });

    socket.on("start-stream", ({ roomId, userId }) => {
        console.log(`📡 Stream started by ${userId} in room ${roomId}`);
        socket.to(roomId).emit("stream-started", { userId });
    });

    socket.on("stop-stream", ({ roomId, userId }) => {
        console.log(`📡 Stream stopped by ${userId} in room ${roomId}`);
        socket.to(roomId).emit("stream-stopped", { userId });
    });

    socket.on("offer", ({ roomId, offer, userId }) => {
        console.log(`📡 Offer received from ${userId} in room ${roomId}`);
        socket.to(roomId).emit("offer", { offer, userId });
    });

    socket.on("answer", ({ roomId, answer, userId }) => {
        console.log(`📡 Answer received from ${userId} in room ${roomId}`);
        socket.to(roomId).emit("answer", { answer, userId });
    });

    socket.on("ice-candidate", ({ roomId, candidate, userId }) => {
        console.log(`📡 ICE candidate received from ${userId} in room ${roomId}`);
        socket.to(roomId).emit("ice-candidate", { candidate, userId });
    });

    socket.on("leave-room", async ({ roomId, userId }) => {
        socket.leave(roomId);

        if (rooms[roomId]) {
            rooms[roomId].participants = rooms[roomId].participants.filter((id) => id !== userId);

            if (rooms[roomId].participants.length === 0) {
                delete rooms[roomId];
                console.log(`🗑️ Room ${roomId} deleted (no participants left)`);
            } else {
                io.to(roomId).emit("update-participants", {
                    participants: rooms[roomId].participants,
                });

                // Emit updated room details after a user leaves
                const roomDetails = await fetchRoomDetails(roomId);
                if (roomDetails) {
                    io.to(roomId).emit("room-details", roomDetails);
                }
            }
        }

        console.log(`🚪 User ${userId} left room ${roomId}`);
    });

    socket.on("disconnect", async () => {
        console.log(`❌ User disconnected: ${socket.id}`);

        for (const roomId in rooms) {
            rooms[roomId].participants = rooms[roomId].participants.filter((id) => id !== socket.id);

            if (rooms[roomId].participants.length === 0) {
                delete rooms[roomId];
                console.log(`🗑️ Room ${roomId} deleted (no participants left)`);
            } else {
                io.to(roomId).emit("update-participants", {
                    participants: rooms[roomId].participants,
                });

                // Emit updated room details after a user disconnects
                const roomDetails = await fetchRoomDetails(roomId);
                if (roomDetails) {
                    io.to(roomId).emit("room-details", roomDetails);
                }
            }
        }
    });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
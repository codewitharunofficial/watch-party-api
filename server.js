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
import Message from "./models/Message.js";
import User from "./models/User.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());
app.use(cors());

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => console.error("❌ MongoDB Connection Failed:", err));

app.use("/api/auth", authRoutes);
app.use("/api/room", roomRoutes);
app.use("/api/message", messageRoutes);

app.use('/keep-alive', (req, res) => {
    res.status(200).send({success: true});
})

// Map to store socket.id to userId mapping
const socketToUserMap = new Map();

// Helper function to validate ObjectId
const isValidObjectId = (id) => {
    if (typeof id !== "string") {
        return false;
    }
    return mongoose.Types.ObjectId.isValid(id.trim());
};

// Helper function to fetch room details
const fetchRoomDetails = async (roomId) => {
    try {
        const room = await Room.findById(roomId).lean();
        if (!room) {
            throw new Error(`Room ${roomId} not found`);
        }

        // Map the users array to the format expected by the client
        const participants = room.users.map((user) => ({
            id: user.id.toString(),
            username: user.username,
            profilePic: user.profilePic,
            email: user.email,
        }));

        return {
            adminName: room.adminName,
            participants,
            activeUsersCount: participants.length,
        };
    } catch (error) {
        console.error("Error fetching room details:", error.message);
        return null;
    }
};

io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    socket.on("create-room", async ({ userId, userName }) => {
        console.log(`🔹 Create-room request received with userId: ${userId}, userName: ${userName}`);
        try {
            // Validate inputs
            if (!userId || !isValidObjectId(userId)) {
                throw new Error("Invalid userId: must be a valid ObjectId");
            }

            if (!userName || typeof userName !== "string") {
                throw new Error("Invalid userName: must be a non-empty string");
            }

            // Check if the user exists
            const admin = await User.findById(userId).lean();
            if (!admin) {
                throw new Error(`User ${userId} not found`);
            }

            // Check if the user already has a room and delete it
            const existingRoom = await Room.findOne({ admin: userId });
            if (existingRoom) {
                await Room.deleteOne({ admin: userId });
                await Message.deleteMany({ room: existingRoom._id });
                console.log(`Deleted existing room for user ${userId}: ${existingRoom._id}`);
            }

            // Create a new room with the admin as the first user
            const room = new Room({
                name: `${userName}-Room-${Date.now()}`,
                admin: userId,
                adminName: userName,
                users: [
                    {
                        id: userId,
                        username: admin.username,
                        profilePic: admin.profilePic || null,
                        email: admin.email || "No email",
                    },
                ],
                videoUrl: "",
                serviceId: "1",
                isPlaying: false,
                playbackTime: 0,
            });

            await room.save();

            const roomId = room._id.toString();

            socket.join(roomId);
            socketToUserMap.set(socket.id, userId);

            io.to(roomId).emit("room-created", {
                roomId,
                adminId: room.admin.toString(),
                users: room.users.map((user) => user.id.toString()),
                adminName: room.adminName,
            });

            console.log(`🚀 Room created: ${roomId}, Admin: ${room.admin}`);

            const roomDetails = await fetchRoomDetails(roomId);
            io.to(roomId).emit("room-details", roomDetails);
        } catch (error) {
            console.error("❌ Room creation failed:", error.message);
            socket.emit("room-error", `Failed to create room: ${error.message}`);
        }
    });

    socket.on("join-room", async ({ roomId, userId }) => {
        console.log(`🔹 Join request received for Room ID: ${roomId}, userId: ${userId}`);
        try {
            // Validate inputs
            if (!isValidObjectId(userId)) {
                throw new Error("Invalid userId: must be a valid ObjectId");
            }

            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                console.log(`❌ Room ${roomId} does not exist in database.`);
                socket.emit("room-error", `Room ${roomId} does not exist`);
                return;
            }

            // Check if the user exists
            const user = await User.findById(userId).lean();
            if (!user) {
                throw new Error(`User ${userId} not found`);
            }

            socket.join(roomId);
            socketToUserMap.set(socket.id, userId);

            // Add user to the room's users array if not already present
            const userExists = room.users.some((u) => u.id.toString() === userId);
            if (!userExists) {
                await Room.findByIdAndUpdate(roomId, {
                    $push: {
                        users: {
                            id: userId,
                            username: user.username,
                            profilePic: user.profilePic || null,
                            email: user.email || "No email",
                        },
                    },
                });
            }

            // Fetch the updated room to get the latest users list
            const updatedRoom = await Room.findById(roomId).lean();

            socket.emit("room-joined", {
                roomId,
                adminId: updatedRoom.admin.toString(),
                videoUrl: updatedRoom.videoUrl || "",
                adminName: updatedRoom.adminName,
                users: updatedRoom.users,
            });

            console.log(`✅ User ${userId} joined room ${roomId} created by ${updatedRoom.adminName}`);
            io.to(roomId).emit("update-participants", {
                participants: updatedRoom.users,
            });

            const roomDetails = await fetchRoomDetails(roomId);
            if (roomDetails) {
                io.to(roomId).emit("room-details", roomDetails);
            } else {
                socket.emit("room-error", `Failed to fetch room details for room ${roomId}`);
            }
        } catch (error) {
            console.log(`❌ Join-room failed for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to join room: ${error.message}`);
        }
    });

    socket.on("play-video", async ({ roomId, url, adminId }) => {
        console.log("🎥 Play video request received:", url);
        try {
            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                throw new Error(`Room ${roomId} not found`);
            }

            if (room.admin.toString() !== adminId) {
                console.log(`❌ Unauthorized attempt by ${adminId}`);
                socket.emit("room-error", "Only the admin can set the video");
                return;
            }

            console.log(`✅ Admin authorized. Updating video for room: ${roomId}`);

            // Update the Room document in the database
            await Room.findByIdAndUpdate(roomId, {
                videoUrl: url,
                serviceId: "1",
                isPlaying: false,
                playbackTime: 0,
            });

            io.to(roomId).emit("load-video", { url });
            console.log(`Emitted load-video to room ${roomId} with URL: ${url}`);
        } catch (error) {
            console.error(`Error in play-video for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to play video: ${error.message}`);
        }
    });

    socket.on("pause-video", async ({ roomId, time, adminId }) => {
        try {
            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                throw new Error(`Room ${roomId} not found`);
            }

            if (room.admin.toString() !== adminId) {
                console.log(`❌ Unauthorized pause attempt by ${adminId}`);
                return;
            }

            console.log(`⏸️ Pause video at ${time}s for room ${roomId}`);

            // Update the Room document in the database
            await Room.findByIdAndUpdate(roomId, {
                isPlaying: false,
                playbackTime: time,
            });

            io.to(roomId).emit("pause-video", { time });
        } catch (error) {
            console.error(`Error in pause-video for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to pause video: ${error.message}`);
        }
    });

    socket.on("resume-video", async ({ roomId, time, adminId }) => {
        try {
            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                throw new Error(`Room ${roomId} not found`);
            }

            if (room.admin.toString() !== adminId) {
                console.log(`❌ Unauthorized resume attempt by ${adminId}`);
                return;
            }

            console.log(`▶️ Resume video at ${time}s for room ${roomId}`);

            // Update the Room document in the database
            await Room.findByIdAndUpdate(roomId, {
                isPlaying: true,
                playbackTime: time,
            });

            io.to(roomId).emit("resume-video", { time });
        } catch (error) {
            console.error(`Error in resume-video for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to resume video: ${error.message}`);
        }
    });

    socket.on("seek-video", async ({ roomId, time, adminId }) => {
        try {
            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                throw new Error(`Room ${roomId} not found`);
            }

            if (room.admin.toString() !== adminId) {
                console.log(`❌ Unauthorized seek attempt by ${adminId}`);
                return;
            }

            console.log(`⏩ Seek video to ${time}s for room ${roomId}`);

            // Update the Room document in the database
            await Room.findByIdAndUpdate(roomId, {
                playbackTime: time,
            });

            io.to(roomId).emit("seek-video", { time });
        } catch (error) {
            console.error(`Error in seek-video for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to seek video: ${error.message}`);
        }
    });

    socket.on("send-message", async ({ roomId, msg }) => {
        console.log(`💬 Message received in room ${roomId} from ${msg.userId}: ${msg.text}`);
        try {
            if (!isValidObjectId(msg.userId)) {
                throw new Error("Invalid userId: must be a valid ObjectId");
            }

            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const user = await User.findById(msg.userId).lean();
            if (!user) {
                throw new Error(`User ${msg.userId} not found`);
            }

            const room = await Room.findById(roomId);
            if (!room) {
                throw new Error(`Room ${roomId} not found`);
            }

            const newMessage = new Message({
                room: roomId,
                senderId: msg.userId,
                text: msg.text,
                sender: user,
            });
            await newMessage.save();
            io.to(roomId).emit("receive-message", newMessage);
        } catch (error) {
            console.error("❌ Message saving failed:", error.message);
            socket.emit("room-error", `Failed to send message: ${error.message}`);
        }
    });

    socket.on("leave-room", async ({ roomId, userId }) => {
        socket.leave(roomId);

        try {
            if (!isValidObjectId(userId)) {
                throw new Error("Invalid userId: must be a valid ObjectId");
            }

            if (!isValidObjectId(roomId)) {
                throw new Error("Invalid roomId: must be a valid ObjectId");
            }

            const room = await Room.findById(roomId);
            if (!room) {
                console.log(`Room ${roomId} not found`);
                return;
            }

            const isAdmin = room.admin.toString() === userId;

            if (isAdmin) {
                // Admin is leaving, dismiss the room
                io.to(roomId).emit("room-dismissed");

                // Delete the room and associated messages from the database
                await Room.findByIdAndDelete(roomId);
                await Message.deleteMany({ room: roomId });

                console.log(`🗑️ Room ${roomId} dismissed by admin ${userId}`);
            } else {
                // Non-admin user is leaving
                await Room.findByIdAndUpdate(roomId, {
                    $pull: { users: { id: userId } },
                });

                // Fetch the updated room to check the users list
                const updatedRoom = await Room.findById(roomId).lean();
                if (!updatedRoom) {
                    console.log(`Room ${roomId} not found after update`);
                    return;
                }

                if (updatedRoom.users.length === 0) {
                    await Room.findByIdAndDelete(roomId);
                    await Message.deleteMany({ room: roomId });
                    console.log(`🗑️ Room ${roomId} deleted (no participants left)`);
                } else {
                    io.to(roomId).emit("update-participants", {
                        participants: updatedRoom.users.map((user) => user.id.toString()),
                    });

                    const roomDetails = await fetchRoomDetails(roomId);
                    if (roomDetails) {
                        io.to(roomId).emit("room-details", roomDetails);
                    }
                }

                console.log(`🚪 User ${userId} left room ${roomId}`);
            }
        } catch (error) {
            console.error(`Error in leave-room for room ${roomId}:`, error.message);
            socket.emit("room-error", `Failed to leave room: ${error.message}`);
        }
    });

    socket.on("disconnect", async () => {
        console.log(`❌ User disconnected: ${socket.id}`);

        const userId = socketToUserMap.get(socket.id);
        if (!userId) {
            console.log(`No userId mapped for socket ${socket.id}`);
            return;
        }

        socketToUserMap.delete(socket.id);

        // Find all rooms where the user is a participant
        const userRooms = await Room.find({ "users.id": userId });
        for (const room of userRooms) {
            const roomId = room._id.toString();
            const isAdmin = room.admin.toString() === userId;

            if (isAdmin) {
                // Admin disconnected, dismiss the room
                io.to(roomId).emit("room-dismissed");

                await Room.findByIdAndDelete(roomId);
                await Message.deleteMany({ room: roomId });

                console.log(`🗑️ Room ${roomId} dismissed due to admin ${userId} disconnection`);
            } else {
                // Remove the user from the room
                await Room.findByIdAndUpdate(roomId, {
                    $pull: { users: { id: userId } },
                });

                // Fetch the updated room to check the users list
                const updatedRoom = await Room.findById(roomId).lean();
                if (!updatedRoom) {
                    console.log(`Room ${roomId} not found after update`);
                    continue;
                }

                if (updatedRoom.users.length === 0) {
                    await Room.findByIdAndDelete(roomId);
                    await Message.deleteMany({ room: roomId });
                    console.log(`🗑️ Room ${roomId} deleted (no participants left)`);
                } else {
                    io.to(roomId).emit("update-participants", {
                        participants: updatedRoom.users.map((user) => user.id.toString()),
                    });

                    const roomDetails = await fetchRoomDetails(roomId);
                    if (roomDetails) {
                        io.to(roomId).emit("room-details", roomDetails);
                    }
                }
            }
        }
    });


    socket.on("join-voice", ({ roomId, userId }) => {
        console.log(`User ${userId} joined voice chat in room ${roomId}`);
        socket.join(`${roomId}-voice`);
        io.to(`${roomId}-voice`).emit("user-joined-voice", { userId });
    });

    socket.on("leave-voice", ({ roomId, userId }) => {
        console.log(`User ${userId} left voice chat in room ${roomId}`);
        socket.leave(`${roomId}-voice`);
        io.to(`${roomId}-voice`).emit("user-left-voice", { userId });
    });

    socket.on("voice-offer", ({ to, offer }) => {
        console.log(`Sending voice offer from ${socket.id} to ${to}`);
        io.to(to).emit("voice-offer", { from: socket.id, offer });
    });

    socket.on("voice-answer", ({ to, answer }) => {
        console.log(`Sending voice answer from ${socket.id} to ${to}`);
        io.to(to).emit("voice-answer", { from: socket.id, answer });
    });

    socket.on("voice-candidate", ({ to, candidate }) => {
        console.log(`Sending ICE candidate from ${socket.id} to ${to}`);
        io.to(to).emit("voice-candidate", { from: socket.id, candidate });
    });

    socket.on("mic-enabled", ({ roomId, userId }) => {
        console.log(`User ${userId} enabled mic in room ${roomId}`);
        io.to(`${roomId}-voice`).emit("mic-enabled", { userId });
    });

    socket.on("mic-disabled", ({ roomId, userId }) => {
        console.log(`User ${userId} disabled mic in room ${roomId}`);
        io.to(`${roomId}-voice`).emit("mic-disabled", { userId });
    });

});



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
// models/Room.js
import mongoose from "mongoose";

const RoomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    adminName: {
        type: String,
        required: true,
    },
    users: [
        {
            id: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true,
            },
            username: {
                type: String,
                required: true,
            },
            profilePic: {
                type: String,
                default: null,
            },
            email: {
                type: String,
                default: "No email",
            },
        },
    ],
    videoUrl: {
        type: String,
        default: "",
    },
    serviceId: {
        type: String,
        default: "1", // 1 for YouTube
    },
    isPlaying: {
        type: Boolean,
        default: false,
    },
    playbackTime: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Add indexes for frequently queried fields
RoomSchema.index({ admin: 1 });

export default mongoose.model("Room", RoomSchema);
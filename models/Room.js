import mongoose from "mongoose";

const roomSchema = new mongoose.Schema({
    name: { type: String, required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    videoUrl: { type: String, default: "" },
    isPlaying: { type: Boolean, default: false },
    playbackTime: { type: Number, default: 0 },
    adminName: { type: String, required: true },
}, { timestamps: true });

const Room = mongoose.model("Room", roomSchema);

export default Room;

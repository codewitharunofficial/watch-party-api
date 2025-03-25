import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room" },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    sender: { type: Object, required: true },
});

const Message = mongoose.model("Message", messageSchema);

export default Message;

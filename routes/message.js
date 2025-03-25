import express from "express";
import Message from "../models/Message.js";

const router = express.Router();

router.get("/:roomId", async (req, res) => {
    const messages = await Message.find({ room: req.params.roomId }).populate("sender");
    res.json(messages);
});

export default router;

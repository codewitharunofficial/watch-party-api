import express from "express";
import Room from "../models/Room.js";

const router = express.Router();

// ✅ Create Room
router.post("/create", async (req, res) => {
    const { name, admin } = req.body;

    try {
        const room = new Room({
            name,
            admin,   // Store admin ID
            users: [admin],
        });

        await room.save();
        res.json(room);
    } catch (error) {
        res.status(500).json({ error: "Failed to create room" });
    }
});

// ✅ Get Room Info (including admin)
router.get("/:roomId", async (req, res) => {
    try {
        const room = await Room.findById(req.params.roomId)
            .populate("admin")
            .populate("users");

        if (!room) {
            return res.status(404).json({ error: "Room not found" });
        }

        res.json(room);
    } catch (error) {
        res.status(500).json({ error: "Failed to get room info" });
    }
});

export default router;

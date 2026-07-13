const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Automatically load local .env if it exists (for local testing)
require("dotenv").config({ silent: true });

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;
// Reads safely from your host configuration panel
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const DATA_FILE = path.join(__dirname, "database.json");
const AUTH_FILE = path.join(__dirname, "auth.json");

// --- PERSISTENT STORAGE INITIALIZATION ---
let db = {
    TRACKED_PLACE_IDS: [6516141723, 18186775539, 14782959537, 121776770216184, 74410589950588, 139814426336895, 106488404064306, 95959136210771, 112773882744514, 89944607133829, 14232592026, 84323123259073, 87529023558870, 84643998589421],
    BUT_BAD_PLACE_IDS: [10704934612, 11648546848, 102512968717570, 10966157497]
};

if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { }
} else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 4));
}

function saveDatabase() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 4)); }

// --- CRYPTOGRAPHIC SECURITY ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedFormat) {
    const [salt, originalHash] = storedFormat.split(":");
    const currentHash = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(currentHash, "hex"));
}

let credentials = [];
if (fs.existsSync(AUTH_FILE)) {
    credentials = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
} else {
    credentials = [
        { username: "admin", passwordHash: hashPassword("password123") }
    ];
    fs.writeFileSync(AUTH_FILE, JSON.stringify(credentials, null, 4));
}

const ACTIVE_TOKENS = new Set();
const requireAdminAuth = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token && ACTIVE_TOKENS.has(token)) return next();
    res.status(403).json({ error: "Access Denied" });
};

// --- ROUTES ---
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    const account = credentials.find(u => u.username === username);
    if (account && verifyPassword(password, account.passwordHash)) {
        const secureToken = "tkn_" + crypto.randomBytes(32).toString("hex");
        ACTIVE_TOKENS.add(secureToken);
        return res.json({ success: true, token: secureToken });
    }
    res.status(401).json({ error: "Invalid credentials" });
} canvas);

// Public API Engine with Error Hardening
app.get("/api/games", async (req, res) => {
    try {
        const allIds = [...db.TRACKED_PLACE_IDS, ...db.BUT_BAD_PLACE_IDS];
        if (!allIds.length) return res.json([]);

        const universeMappings = {};
        const placeToUniversePromises = allIds.map(async (id) => {
            try {
                const res = await axios.get(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
                if (res.data?.universeId) {
                    universeMappings[res.data.universeId] = id;
                    return res.data.universeId;
                }
            } catch (err) { }
            return null;
        });

        const unresolvedIds = await Promise.all(placeToUniversePromises);
        const universeIds = unresolvedIds.filter(id => id !== null);

        if (!universeIds.length) return res.json([]);
        const universeCsv = universeIds.join(",");

        const [statsRes, iconRes, thumbRes, voteRes] = await Promise.allSettled([
            axios.get(`https://games.roblox.com/v1/games?universeIds=${universeCsv}`),
            axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeCsv}&returnPolicy=PlaceHolder&size=512x512&format=Png`),
            axios.get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeCsv}&countPerUniverse=5&defaults=true&size=768x432&format=Png`),
            axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${universeCsv}`)
        ]);

        const statsData = statsRes.status === "fulfilled" ? statsRes.value.data?.data || [] : [];
        const iconsData = iconRes.status === "fulfilled" ? iconRes.value.data?.data || [] : [];
        const thumbsData = thumbRes.status === "fulfilled" ? thumbRes.value.data?.data || [] : [];
        const votesData = voteRes.status === "fulfilled" ? voteRes.value.data?.data || [] : [];

        const compiledGames = statsData.map(stats => {
            const uId = stats.id;
            const placeId = universeMappings[uId];
            
            const matchIcon = iconsData.find(i => i.targetId === uId)?.imageUrl || "";
            const rawThumbs = thumbsData.find(t => t.universeId === uId)?.thumbnails || [];
            let thumbnails = rawThumbs.filter(t => t?.state === "Completed" && t.imageUrl).map(t => t.imageUrl);
            if (!thumbnails.length && matchIcon) thumbnails.push(matchIcon);

            const voteObj = votesData.find(v => v.id === uId) || { upVotes: 0, downVotes: 0 };
            const history = Array.from({ length: 7 }, () => Math.floor(stats.playing * (0.8 + Math.random() * 0.4)));

            let category = "Popular";
            if (db.BUT_BAD_PLACE_IDS.includes(placeId)) {
                category = "But Bad";
            } else if (stats.visits < 500000 || stats.playing < 10) {
                category = "Unpopular";
            }

            return {
                id: placeId,
                universeId: uId,
                name: stats.name || "Deleted / Content Deleted",
                creator: stats.creator?.name || "Unknown", // 🌟 Fixed: Optional chaining prevents 500 crash
                description: stats.description || "No description provided.",
                activePlayers: stats.playing || 0,
                visits: stats.visits || 0,
                upVotes: voteObj.upVotes || 0,
                downVotes: voteObj.downVotes || 0,
                icon: matchIcon,
                thumbnails,
                history,
                category
            };
        });

        res.json(compiledGames);
    } catch (err) {
        console.error("Critical Engine Breakdown:", err.message);
        res.status(500).json({ error: "Internal Server Processing Error" });
    }
});

app.post("/api/request-game", async (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: "Game ID required." });
    try {
        if (!DISCORD_WEBHOOK_URL) return res.status(500).json({ error: "Webhook not configured" });
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🚪 New Game Request",
                color: 65280,
                fields: [{ name: "Game ID", value: gameId.toString() }]
            }]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Webhook failed to forward." });
    }
});

app.listen(PORT, () => console.log(`🚀 Secure App listening on port ${PORT}`));

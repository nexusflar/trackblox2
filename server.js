const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

let TRACKED_PLACE_IDS = [6516141723, 18186775539, 14782959537, 121776770216184, 74410589950588, 139814426336895, 106488404064306, 95959136210771, 112773882744514, 89944607133829, 14232592026, 84323123259073, 87529023558870, 84643998589421];
let BUT_BAD_PLACE_IDS = [10704934612, 11648546848, 102512968717570, 10966157497];

const ACTIVE_TOKENS = new Set();

const requireAdminAuth = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token && ACTIVE_TOKENS.has(token)) return next();
    res.status(403).json({ error: "Access Denied" });
};

// --- FRONTEND ROUTING PATHWAYS ---
app.get("/", (req, res) => {
    res.sendFile(path.resolve(process.cwd(), "index.html"));
});

app.get("/admin-login", (req, res) => {
    res.sendFile(path.resolve(process.cwd(), "admin.html"));
});

// --- ADMIN ENDPOINTS ---
app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    
    console.log("RAW ENV VALUE:", process.env.ADMIN_ACCOUNTS);

    let adminAccounts = [];
    try {
        if (process.env.ADMIN_ACCOUNTS) {
            adminAccounts = JSON.parse(process.env.ADMIN_ACCOUNTS);
        }
    } catch (err) {
        return res.status(500).json({ error: `JSON Parse Failed: ${err.message}`, rawReceived: process.env.ADMIN_ACCOUNTS });
    }

    const matchedAccount = adminAccounts.find(
        account => account.username === username && account.password === password
    );

    if (matchedAccount) {
        const secureToken = "tkn_" + crypto.randomBytes(32).toString("hex");
        ACTIVE_TOKENS.add(secureToken);
        return res.json({ success: true, token: secureToken });
    }
    res.status(401).json({ error: "Invalid credentials", fallbackActive: adminAccounts.length === 0 });
});

app.get("/api/admin/list-ids", requireAdminAuth, (req, res) => {
    res.json({ popular: TRACKED_PLACE_IDS, butBad: BUT_BAD_PLACE_IDS });
});

app.post("/api/admin/add-id", requireAdminAuth, (req, res) => {
    const { gameId, category } = req.body;
    const numericId = parseInt(gameId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: "Invalid ID format" });

    if (category === "butBad") {
        if (!BUT_BAD_PLACE_IDS.includes(numericId)) BUT_BAD_PLACE_IDS.push(numericId);
    } else {
        if (!TRACKED_PLACE_IDS.includes(numericId)) TRACKED_PLACE_IDS.push(numericId);
    }
    res.json({ success: true });
});

app.post("/api/admin/delete-id", requireAdminAuth, (req, res) => {
    const { gameId } = req.body;
    const numericId = parseInt(gameId, 10);
    TRACKED_PLACE_IDS = TRACKED_PLACE_IDS.filter(id => id !== numericId);
    BUT_BAD_PLACE_IDS = BUT_BAD_PLACE_IDS.filter(id => id !== numericId);
    res.json({ success: true });
});

// --- ENGINE COMPILATION CORE ---
app.get("/api/games", async (req, res) => {
    try {
        const allIds = [...TRACKED_PLACE_IDS, ...BUT_BAD_PLACE_IDS];
        if (!allIds.length) return res.json([]);

        const universeMappings = {};
        const placeToUniversePromises = allIds.map(async (id) => {
            try {
                const response = await axios.get(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
                if (response.data?.universeId) {
                    universeMappings[response.data.universeId] = id;
                    return response.data.universeId;
                }
            } catch (err) {}
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
            if (BUT_BAD_PLACE_IDS.includes(placeId)) {
                category = "But Bad";
            } else if (stats.visits < 500000 || stats.playing < 10) {
                category = "Unpopular";
            }

            return {
                id: placeId,
                universeId: uId,
                name: stats.name || "Content Deleted",
                creator: stats.creator?.name || "Unknown/Deleted",
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
        res.status(500).json({ error: "Failed to compile live server metrics." });
    }
});

// --- REQUEST GAME PIPELINE ---
app.post("/api/request-game", async (req, res) => {
    let { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: "Game ID or URL required." });

    // Extract raw numbers if a player pastes a full Roblox link
    const urlMatch = gameId.match(/games\/(\d+)/);
    if (urlMatch) {
        gameId = urlMatch[1];
    }

    try {
        if (!DISCORD_WEBHOOK_URL) return res.status(500).json({ error: "Webhook transmission line down." });
        
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🚪 New Game Request Received",
                color: 5814783,
                description: `A user has submitted a tracker look-up request.`,
                fields: [
                    { name: "Target ID", value: `\`${gameId}\``, inline: true },
                    { name: "Roblox Link", value: `[Click Here to View](https://www.roblox.com/games/${gameId})`, inline: true }
                ],
                timestamp: new Date()
            }]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to pipe data to Discord channel." });
    }
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

module.exports = app;

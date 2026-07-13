const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

// Automatically read local configurations from your .env file
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

// Pull the Webhook link dynamically from environment setups
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Hardcoded initial list structures (Memory arrays optimized for serverless instances)
let TRACKED_PLACE_IDS = [6516141723, 18186775539, 14782959537, 121776770216184, 74410589950588, 139814426336895, 106488404064306, 95959136210771, 112773882744514, 89944607133829, 14232592026, 84323123259073, 87529023558870, 84643998589421];
let BUT_BAD_PLACE_IDS = [10704934612, 11648546848, 102512968717570, 10966157497];

// Storage tracking for valid active login tokens
const ACTIVE_TOKENS = new Set();

// Authorization middleware to block unauthorized requests on internal routes
const requireAdminAuth = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token && ACTIVE_TOKENS.has(token)) return next();
    res.status(403).json({ error: "Access Denied" });
};

// --- FRONTEND ROUTING PATHWAYS ---

// Route to serve your main interface dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Route to open the secure administrator portal page
app.get("/admin-login", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});


// --- ADMIN MANIPULATION PORT ENDPOINTS ---

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


// --- ENGINE COMPILATION CORE (ROBLOX FETCHING) ---

// Dynamic lookup & detail evaluation handler endpoint requested by front-end client
app.get("/api/verify-game", async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Search query required." });

    try {
        let detectedId = null;

        // Clean out and isolate ID from incoming text, direct numbers or roblox game URLs
        const match = query.match(/(?:games|experiences)\/(\d+)/i);
        if (match) {
            detectedId = parseInt(match[1], 10);
        } else {
            const numericFallback = parseInt(query.replace(/\D/g, ""), 10);
            if (!isNaN(numericFallback)) detectedId = numericFallback;
        }

        if (!detectedId) {
            return res.status(400).json({ error: "Could not safely decode a numeric Place ID from input." });
        }

        // 1. Resolve to Universe ID Container Pipeline
        const universeRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${detectedId}/universe`);
        const universeId = universeRes.data?.universeId;
        if (!universeId) return res.status(404).json({ error: "Experience profile not found on Roblox servers." });

        // 2. Multiget Core Game Statistics Data Profiles
        const statsRes = await axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
        const dataPayload = statsRes.data?.data?.[0];
        if (!dataPayload) return res.status(404).json({ error: "Game details completely missing." });

        // 3. Resolve Media Asset Display Icons
        let displayIcon = "";
        try {
            const iconRes = await axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png`);
            displayIcon = iconRes.data?.data?.[0]?.imageUrl || "";
        } catch (e) {}

        res.json({
            id: detectedId,
            universeId: universeId,
            name: dataPayload.name || "Unknown Experience",
            creator: dataPayload.creator?.name || "Unknown Creator",
            icon: displayIcon
        });

    } catch (err) {
        res.status(500).json({ error: "Roblox system lookup engine communication error." });
    }
});

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

// Outward facing forward integration to push new request IDs to Discord
app.post("/api/request-game", async (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: "Game ID required." });
    
    try {
        if (!DISCORD_WEBHOOK_URL) return res.status(500).json({ error: "Webhook transmission line down." });
        
        // 1. Fetch live metadata from Roblox API targets to safely match the exact image formatting
        const universeRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${gameId}/universe`);
        const universeId = universeRes.data?.universeId;
        
        let gameName = "Unknown Game";
        let gameCreator = "Unknown Creator";
        let gameIcon = "";

        if (universeId) {
            const [detailsRes, iconRes] = await Promise.all([
                axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
                axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=150x150&format=Png`)
            ]);
            
            if (detailsRes.data?.data?.[0]) {
                gameName = detailsRes.data.data[0].name;
                gameCreator = detailsRes.data.data[0].creator?.name || "Unknown Creator";
            }
            gameIcon = iconRes.data?.data?.[0]?.imageUrl || "";
        }

        // 2. Dispatch structured embed architecture matching the visual specs perfectly
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🚨 New Tracker Database Request",
                color: 2307921, // Custom dark navy / slate tone hex value conversion
                fields: [
                    { name: "Game Title", value: gameName, inline: true },
                    { name: "Creator", value: gameCreator, inline: true },
                    { name: "Roblox Place ID", value: `\`${gameId}\``, inline: false },
                    { name: "Quick Links", value: `[View Experience on Roblox](https://www.roblox.com/games/${gameId})`, inline: false }
                ],
                thumbnail: gameIcon ? { url: gameIcon } : null,
                footer: {
                    text: "Doors Analytics Submission Pipeline Engine"
                },
                timestamp: new Date().toISOString()
            }]
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Webhook Delivery Failure:", err.message);
        res.status(500).json({ error: "Failed to pipe data to remote channel." });
    }
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running locally on port ${PORT}`));
}

module.exports = app;

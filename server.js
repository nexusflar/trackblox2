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

// Check credentials securely against a list of multiple admin accounts
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

    // Default Fallback Accounts if environment config array parses empty
    if (!adminAccounts || adminAccounts.length === 0) {
        adminAccounts = [{ username: "admin", password: "password123" }];
    }

    const matchedAccount = adminAccounts.find(
        account => account.username === username && account.password === password
    );

    if (matchedAccount) {
        const secureToken = "tkn_" + crypto.randomBytes(32).toString("hex");
        ACTIVE_TOKENS.add(secureToken);
        return res.json({ success: true, token: secureToken });
    }
    res.status(401).json({ error: "Invalid credentials" });
});


// --- NEW ADVANCED LOOKUP PIPELINE ---
app.get("/api/verify-game", async (req, res) => {
    let { query } = req.query;
    if (!query) return res.status(400).json({ error: "Search query string required." });

    let placeId = null;
    query = query.trim();

    // 1. Try to extract standard numeric configurations out of links/strings
    const urlMatch = query.match(/roblox\.com\/games\/(\d+)/);
    if (urlMatch) {
        placeId = parseInt(urlMatch[1], 10);
    } else if (/^\d+$/.test(query)) {
        placeId = parseInt(query, 10);
    }

    // 2. Fallback: Search Roblox list endpoint directly by text keywords
    if (!placeId) {
        try {
            const searchRes = await axios.get(`https://games.roblox.com/v1/games/list?keyword=${encodeURIComponent(query)}&maxRows=1`);
            if (searchRes.data?.data?.[0]?.placeId) {
                placeId = searchRes.data.data[0].placeId;
            }
        } catch (err) {
            return res.status(500).json({ error: "Roblox text lookup engine is currently unreachable." });
        }
    }

    if (!placeId) return res.status(404).json({ error: "Could not find any matching Roblox game." });

    // 3. Collect asset thumbnails and metadata schemas using Place ID
    try {
        const universeRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
        const universeId = universeRes.data?.universeId;
        if (!universeId) return res.status(404).json({ error: "Failed resolving Place ID to a valid Universe ID." });

        const [statsRes, iconRes, thumbRes] = await Promise.allSettled([
            axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
            axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png`),
            axios.get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=1&defaults=true&size=768x432&format=Png`)
        ]);

        const stats = statsRes.status === "fulfilled" ? statsRes.value.data?.data?.[0] : null;
        const icon = iconRes.status === "fulfilled" ? iconRes.value.data?.data?.[0]?.imageUrl : "";
        const thumb = thumbRes.status === "fulfilled" ? thumbRes.value.data?.data?.[0]?.thumbnails?.[0]?.imageUrl : "";

        res.json({
            id: placeId,
            name: stats?.name || "Unknown Experience",
            creator: stats?.creator?.name || "Unknown Creator",
            icon: icon || thumb,
            thumbnail: thumb || icon
        });
    } catch (err) {
        res.status(500).json({ error: "Failed pulling verified Roblox game metrics." });
    }
});


// --- STANDARD USER DISCORD WEBHOOK PIPE ---
app.post("/api/request-game", async (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: "Missing Target gameId Parameter." });

    if (!DISCORD_WEBHOOK_URL) {
        console.error("ALERT: Webhook transmission line missing from environment variables.");
        return res.status(500).json({ error: "Webhook transmission line down." });
    }

    try {
        // Fetch fresh details for the webhook report card summary
        const universeRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${gameId}/universe`);
        const universeId = universeRes.data?.universeId;
        
        let gameName = "Unknown Experience";
        let gameCreator = "Unknown Creator";
        let iconUrl = "https://www.roblox.com/images/roblox_red.png";

        if (universeId) {
            const [statsRes, iconRes] = await Promise.allSettled([
                axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
                axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=150x150&format=Png`)
            ]);
            if (statsRes.status === "fulfilled") {
                gameName = statsRes.value.data?.data?.[0]?.name || gameName;
                gameCreator = statsRes.value.data?.data?.[0]?.creator?.name || gameCreator;
            }
            if (iconRes.status === "fulfilled") {
                iconUrl = iconRes.value.data?.data?.[0]?.imageUrl || iconUrl;
            }
        }

        // Construct rich Discord embed message packet structure
        const embedPayload = {
            embeds: [{
                title: "🚨 New Tracker Database Request",
                color: 16777215, // White accent sidebar line block
                thumbnail: { url: iconUrl },
                fields: [
                    { name: "Game Title", value: `**${gameName}**`, inline: true },
                    { name: "Creator", value: `${gameCreator}`, inline: true },
                    { name: "Roblox Place ID", value: `\`${gameId}\``, inline: false },
                    { name: "Quick Links", value: `[View Experience on Roblox](https://www.roblox.com/games/${gameId})` }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "Doors Analytics Submission Pipeline Engine" }
            }]
        };

        await axios.post(DISCORD_WEBHOOK_URL, embedPayload);
        res.json({ success: true, message: "Webhook payload transmitted successfully!" });
    } catch (err) {
        console.error("Webhook processing failure state:", err.message);
        res.status(500).json({ error: "Failed to dispatch payload data downstream." });
    }
});


// --- GLOBAL PRIMARY ANALYTICS COMBINE COMPILATION ENGINE ---
app.get("/api/games", async (req, res) => {
    try {
        const allIds = [...new Set([...TRACKED_PLACE_IDS, ...BUT_BAD_PLACE_IDS])];
        if (allIds.length === 0) return res.json([]);

        // Get Universe mapping allocations
        const universeMapping = {};
        const universeIds = [];
        
        await Promise.all(allIds.map(async (pid) => {
            try {
                const mapRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${pid}/universe`);
                if (mapRes.data?.universeId) {
                    universeMapping[pid] = mapRes.data.universeId;
                    universeIds.push(mapRes.data.universeId);
                }
            } catch (e) { }
        }));

        if (universeIds.length === 0) return res.json([]);

        const uniqueUniverseIds = [...new Set(universeIds)];

        // Run multi-channel promise fetches across metrics systems
        const [gamesRes, iconsRes, thumbsRes, votesRes] = await Promise.allSettled([
            axios.get(`https://games.roblox.com/v1/games?universeIds=${uniqueUniverseIds.join(",")}`),
            axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${uniqueUniverseIds.join(",")}&returnPolicy=PlaceHolder&size=150x150&format=Png`),
            axios.get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${uniqueUniverseIds.join(",")}&countPerUniverse=3&defaults=true&size=768x432&format=Png`),
            axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${uniqueUniverseIds.join(",")}`)
        ]);

        const gamesData = gamesRes.status === "fulfilled" ? gamesRes.value.data?.data || [] : [];
        const iconsData = iconsRes.status === "fulfilled" ? iconsRes.value.data?.data || [] : [];
        const thumbsData = thumbsRes.status === "fulfilled" ? thumbsRes.value.data?.data || [] : [];
        const votesData = votesRes.status === "fulfilled" ? votesRes.value.data?.data || [] : [];

        // Build key index references for quick access
        const gamesMap = new Map(gamesData.map(g => [g.id, g]));
        const iconsMap = new Map(iconsData.map(i => [i.targetId, i.imageUrl]));
        const thumbsMap = new Map(thumbsData.map(t => [t.universeId, t.thumbnails?.map(img => img.imageUrl) || []]));
        const votesMap = new Map(votesData.map(v => [v.id, v]));

        const synthesizedOutputPayload = allIds.map(pid => {
            const uid = universeMapping[pid];
            if (!uid) return null;

            const g = gamesMap.get(uid);
            const voteObj = votesMap.get(uid);

            if (!g) return null;

            let assignedCategory = "Popular";
            if (BUT_BAD_PLACE_IDS.includes(pid)) {
                assignedCategory = "But Bad";
            } else if (g.playing < 25) {
                assignedCategory = "Unpopular";
            }

            // Generate synthetic historical node plots for the graph curves
            const baseVal = g.playing || 0;
            const mockHistoryCurve = [
                Math.round(baseVal * 0.85),
                Math.round(baseVal * 1.1),
                Math.round(baseVal * 0.95),
                Math.round(baseVal * 0.7),
                Math.round(baseVal * 1.05),
                Math.round(baseVal * 1.2),
                baseVal
            ];

            return {
                id: pid,
                universeId: uid,
                name: g.name,
                description: g.description,
                creator: g.creator?.name || "Unknown Author",
                activePlayers: g.playing || 0,
                visits: g.visits || 0,
                icon: iconsMap.get(uid) || "",
                thumbnails: thumbsMap.get(uid) || [],
                upVotes: voteObj?.upVotes || 50,
                downVotes: voteObj?.downVotes || 0,
                category: assignedCategory,
                history: mockHistoryCurve
            };
        }).filter(item => item !== null);

        res.json(synthesizedOutputPayload);
    } catch (err) {
        console.error("Critical core runtime breakdown exception:", err);
        res.status(500).json({ error: "Global compilation analytics loop failure." });
    }
});

// Start the network listening port interface context
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend server successfully active on port ${PORT}`));

module.exports = app;

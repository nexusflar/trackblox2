const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 5000;
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1525962159622717490/KNNJAIkNStqi_gaC-Hn8fYYm8rULbKvt8l0RhQUE3T7MCqa8lQd70FSrKh34QGsjoXcO"

const TRACKED_PLACE_IDS = [6516141723, 18186775539, 14782959537, 121776770216184, 74410589950588, 139814426336895, 106488404064306, 112773882744514];
const BUT_BAD_PLACE_IDS = [10704934612, 11648546848, 102512968717570, 10966157497];

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/games", async (req, res) => {
    try {
        const allIds = [...TRACKED_PLACE_IDS, ...BUT_BAD_PLACE_IDS];
        if (!allIds.length) return res.json([]);

        const universeMappings = {};
        const placeToUniversePromises = allIds.map(async (id) => {
            try {
                const res = await axios.get(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
                if (res.data?.universeId) {
                    universeMappings[res.data.universeId] = id;
                    return res.data.universeId;
                }
            } catch (err) {
                console.log(`Skipping Place ID ${id} due to lookup error.`);
            }
            return null;
        });

        const unresolvedIds = await Promise.all(placeToUniversePromises);
        const universeIds = unresolvedIds.filter(id => id !== null);

        if (!universeIds.length) return res.json([]);
        const universeCsv = universeIds.join(",");

        // Batch execution of endpoints prevents Roblox API rate-limiting completely
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
                name: stats.name,
                creator: stats.creator.name,
                description: stats.description || "No description provided.",
                activePlayers: stats.playing,
                visits: stats.visits,
                upVotes: voteObj.upVotes,
                downVotes: voteObj.downVotes,
                icon: matchIcon,
                thumbnails,
                history,
                category
            };
        });

        res.json(compiledGames);
    } catch (err) {
        console.error("Critical Main Engine Breakdown:", err.message);
        res.status(500).json({ error: "Failed to load games completely." });
    }
});

app.post("/api/request-game", async (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: "Game ID required." });
    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "🚪 New Game Request",
                color: 65280,
                fields: [{ name: "Game ID", value: gameId.toString() }]
            }]
        });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: "Webhook failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

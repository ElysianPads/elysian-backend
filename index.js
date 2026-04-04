const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// 🔐 Password protection (VERY IMPORTANT)
app.use((req, res, next) => {
  const auth = req.headers.authorization;

  if (auth !== `Bearer ${process.env.INTERNAL_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// Test route
app.get("/", (req, res) => {
  res.send("Backend is working");
});

// Example: Get properties from Lodgify
app.get("/properties", async (req, res) => {
  const response = await fetch("https://api.lodgify.com/v2/properties", {
    headers: {
      Authorization: `Bearer ${process.env.LODGIFY_API_KEY}`
    }
  });

  const data = await response.json();
  res.json(data);
});

app.listen(3000, () => console.log("Server running"));

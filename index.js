const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Very light "auth": pass logged-in email via 'x-user-email' header
function requireAuth(req, res, next) {
  const userEmail = req.header("x-user-email");
  if (!userEmail) {
    return res
      .status(401)
      .send({ message: "Unauthorized: missing x-user-email" });
  }
  req.userEmail = userEmail;
  next();
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Missing MONGODB_URI in environment");
  console.error(
    "Please create a .env file in the server directory with MONGODB_URI=your_connection_string"
  );
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function bootstrap() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await client.connect();
    console.log("✅ Connected to MongoDB!");

    const database = client.db("moviemaster");
    const moviesCollection = database.collection("movies");
    const usersCollection = database.collection("users");

    // Health
    app.get("/", (req, res) => {
      res.send("MovieMaster Pro Server is running");
    });

    // Movies: list (public)
    app.get("/movies", async (req, res) => {
      try {
        const { genre, search, sortBy } = req.query;
        const query = {};

        if (genre && genre !== "All") {
          query.genre = genre;
        }

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { director: { $regex: search, $options: "i" } },
            { cast: { $regex: search, $options: "i" } },
          ];
        }

        const sort = {};
        if (sortBy === "rating") sort.rating = -1;
        else if (sortBy === "year") sort.releaseYear = -1;
        else if (sortBy === "title") sort.title = 1;

        const movies = await moviesCollection.find(query).sort(sort).toArray();
        res.send(movies);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Movie details (public)
    app.get("/movies/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const movie = await moviesCollection.findOne({ _id: new ObjectId(id) });
        if (!movie) return res.status(404).send({ message: "Movie not found" });
        res.send(movie);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Add movie (protected)
    app.post("/movies/add", requireAuth, async (req, res) => {
      try {
        const movie = req.body || {};
        movie.addedBy = req.userEmail;
        movie.createdAt = new Date();

        // Basic field normalization to align with example JSON
        const doc = {
          title: movie.title,
          genre: movie.genre,
          releaseYear: Number(movie.releaseYear),
          director: movie.director,
          cast: movie.cast,
          rating: Number(movie.rating),
          duration: Number(movie.duration),
          plotSummary: movie.plotSummary,
          posterUrl: movie.posterUrl,
          language: movie.language,
          country: movie.country,
          addedBy: movie.addedBy,
          createdAt: movie.createdAt,
        };

        const result = await moviesCollection.insertOne(doc);
        res.status(201).send({ insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // My collection (protected)
    app.get("/movies/my-collection", requireAuth, async (req, res) => {
      try {
        const movies = await moviesCollection
          .find({ addedBy: req.userEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(movies);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Update (owner only, protected)
    app.put("/movies/update/:id", requireAuth, async (req, res) => {
      try {
        const id = req.params.id;
        const existing = await moviesCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!existing)
          return res.status(404).send({ message: "Movie not found" });
        if (existing.addedBy !== req.userEmail) {
          return res.status(403).send({ message: "Forbidden: not the owner" });
        }

        const payload = { ...req.body };
        // Never allow changing owner
        delete payload.addedBy;
        delete payload._id;

        const updateDoc = {
          $set: {
            ...payload,
            updatedAt: new Date(),
          },
        };
        const result = await moviesCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Delete (owner only, protected)
    app.delete("/movies/:id", requireAuth, async (req, res) => {
      try {
        const id = req.params.id;
        const existing = await moviesCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!existing)
          return res.status(404).send({ message: "Movie not found" });
        if (existing.addedBy !== req.userEmail) {
          return res.status(403).send({ message: "Forbidden: not the owner" });
        }
        const result = await moviesCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Home page APIs
    app.get("/home/stats", async (_req, res) => {
      try {
        const [totalMovies, totalUsers] = await Promise.all([
          moviesCollection.estimatedDocumentCount(),
          usersCollection.estimatedDocumentCount(),
        ]);
        res.send({ totalMovies, totalUsers });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/home/top-rated", async (_req, res) => {
      try {
        const movies = await moviesCollection
          .find({})
          .sort({ rating: -1 })
          .limit(5)
          .toArray();
        res.send(movies);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/home/recent", async (_req, res) => {
      try {
        const movies = await moviesCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.send(movies);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/home/featured", async (_req, res) => {
      try {
        const movies = await moviesCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();
        res.send(movies);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);

    // Provide helpful error messages for common issues
    if (err.code === 8000 || err.codeName === "AtlasError") {
      console.error("\n🔧 MongoDB Atlas Authentication Error Solutions:");
      console.error(
        "1. Verify username/password in MongoDB Atlas → Database Access"
      );
      console.error("2. Whitelist your IP in MongoDB Atlas → Network Access");
      console.error("3. Check connection string in .env file");
      console.error(
        "4. If password has special characters (@, #, etc.), URL-encode them"
      );
      console.error("\n💡 Run: node test-connection.js to diagnose the issue");
    }

    process.exit(1);
  }
}

bootstrap();

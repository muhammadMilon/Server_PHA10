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

// Helper function to get next movie ID
async function getNextMovieId(countersCollection, moviesCollection) {
  const result = await countersCollection.findOneAndUpdate(
    { _id: "movieId" },
    { $inc: { sequence_value: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const doc = result?.value;
  if (doc && typeof doc.sequence_value === "number") {
    return doc.sequence_value;
  }

  // If value is missing (older driver versions), fetch directly
  const counterDoc = await countersCollection.findOne({ _id: "movieId" });
  if (counterDoc && typeof counterDoc.sequence_value === "number") {
    return counterDoc.sequence_value;
  }

  // Initialize counter manually if somehow missing
  const [highestMovie] = await moviesCollection
    .find({ id: { $type: "number" } })
    .sort({ id: -1 })
    .limit(1)
    .toArray();

  const fallbackId =
    highestMovie && typeof highestMovie.id === "number"
      ? highestMovie.id + 1
      : 1;

  await countersCollection.updateOne(
    { _id: "movieId" },
    { $set: { sequence_value: fallbackId } },
    { upsert: true }
  );
  return fallbackId;
}

// Helper function to convert movie document to use integer ID
function convertMovieToIntegerId(movie) {
  if (!movie) return null;

  try {
    let id = movie.id || movie._id;

    if (typeof id === "number" && !isNaN(id)) {
      return {
        ...movie,
        _id: id,
        id: id,
      };
    }

    // If _id is ObjectId object, convert to integer
    if (typeof id === "object" && id && id.toString) {
      // If movie already has an id field that's a number, use it
      if (movie.id && typeof movie.id === "number") {
        id = movie.id;
      } else {
        // Convert ObjectId to integer using last 8 hex chars
        const idStr = id.toString();
        id = parseInt(idStr.slice(-8), 16);
        if (isNaN(id) || id <= 0) {
          id = 1; // Default fallback
        }
      }
    } else if (typeof id === "string") {
      // Try to parse as integer
      const parsed = parseInt(id, 10);
      if (!isNaN(parsed) && parsed > 0) {
        id = parsed;
      } else {
        // If it's an ObjectId string, convert it
        if (id.length === 24) {
          id = parseInt(id.slice(-8), 16);
          if (isNaN(id) || id <= 0) {
            id = 1;
          }
        } else {
          id = 1; // Default fallback
        }
      }
    } else if (typeof id !== "number") {
      id = 1; // Default fallback
    }

    // Ensure id is a positive integer
    id = Math.max(1, Math.floor(Number(id)) || 1);

    return {
      ...movie,
      _id: id,
      id: id,
    };
  } catch (error) {
    console.warn("Error converting movie ID:", error, movie);
    // Return with default ID of 1
    return {
      ...movie,
      _id: 1,
      id: 1,
    };
  }
}

async function findMovieByIdentifier(moviesCollection, idParam) {
  if (!idParam) {
    return null;
  }

  const identifier = String(idParam).trim();
  if (!identifier) {
    return null;
  }

  let movie = null;

  const numericId = parseInt(identifier, 10);
  if (!Number.isNaN(numericId) && numericId > 0) {
    movie =
      (await moviesCollection.findOne({ id: numericId })) ||
      (await moviesCollection.findOne({ _id: numericId }));
  }

  if (!movie && ObjectId.isValid(identifier)) {
    try {
      movie = await moviesCollection.findOne({ _id: new ObjectId(identifier) });
    } catch (error) {
      console.error("ObjectId conversion error:", error);
    }
  }

  if (!movie) {
    movie =
      (await moviesCollection.findOne({ _id: identifier })) ||
      (await moviesCollection.findOne({ id: identifier }));
  }

  return movie;
}

function buildWatchlistIdentifierCandidates(idParam) {
  const identifier = String(idParam ?? "").trim();
  const numericId = parseInt(identifier, 10);

  const numericCandidates = new Set();
  const keyCandidates = new Set();

  if (!Number.isNaN(numericId) && numericId > 0) {
    numericCandidates.add(numericId);
    keyCandidates.add(String(numericId));
  }

  if (identifier) {
    keyCandidates.add(identifier);
  }

  return {
    numericCandidates: Array.from(numericCandidates),
    keyCandidates: Array.from(keyCandidates),
  };
}

async function bootstrap() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await client.connect();
    console.log("✅ Connected to MongoDB!");

    const database = client.db("MovieMaster");
    const moviesCollection = database.collection("movies");
    const usersCollection = database.collection("users");
    const watchlistCollection = database.collection("watchlists");
    const countersCollection = database.collection("counters");

    try {
      await watchlistCollection.createIndex(
        { userEmail: 1, movieKey: 1 },
        { unique: true }
      );
      await watchlistCollection.createIndex({ userEmail: 1, createdAt: -1 });
    } catch (indexError) {
      console.warn(
        "Warning: failed to create watchlist indexes",
        indexError?.message || indexError
      );
    }

    // Health
    app.get("/", (req, res) => {
      res.send("MovieMaster Pro Server is running");
    });

    // User management APIs
    app.post("/users/create-or-update", async (req, res) => {
      try {
        const { email, displayName, photoURL, uid } = req.body;
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        // Check if user exists
        const existingUser = await usersCollection.findOne({ email: email });

        if (existingUser) {
          // Update existing user
          const result = await usersCollection.updateOne(
            { email: email },
            {
              $set: {
                displayName: displayName || existingUser.displayName,
                photoURL: photoURL || existingUser.photoURL,
                uid: uid || existingUser.uid,
                lastLoginAt: new Date(),
                updatedAt: new Date(),
              },
            }
          );
          res.send({
            message: "User updated",
            user: { ...existingUser, ...req.body },
          });
        } else {
          // Create new user
          const newUser = {
            email: email,
            displayName: displayName || "",
            photoURL: photoURL || "",
            uid: uid || "",
            createdAt: new Date(),
            lastLoginAt: new Date(),
          };
          const result = await usersCollection.insertOne(newUser);
          res.status(201).send({ message: "User created", user: newUser });
        }
      } catch (error) {
        console.error("Error creating/updating user:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to save user" });
      }
    });

    app.get("/users/check/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email);
        const user = await usersCollection.findOne({ email: email });
        res.send({ exists: !!user });
      } catch (error) {
        console.error("Error checking user:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to check user" });
      }
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

        // Convert all movies to use integer IDs
        const convertedMovies = movies
          .map(convertMovieToIntegerId)
          .filter((m) => m !== null);

        res.send(convertedMovies);
      } catch (error) {
        console.error("Error fetching movies:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch movies" });
      }
    });

    // Add movie (protected)
    app.post("/movies/add", requireAuth, async (req, res) => {
      try {
        const movie = req.body || {};
        const normalizedUserEmail = (req.userEmail || "").toLowerCase();

        if (!normalizedUserEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        movie.addedBy = normalizedUserEmail;
        const now = new Date();
        movie.createdAt = now;
        movie.updatedAt = now;

        // Get next integer ID
        const nextId = await getNextMovieId(
          countersCollection,
          moviesCollection
        );

        // Basic field normalization
        const doc = {
          _id: Number(nextId),
          id: Number(nextId),
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
          addedBy: normalizedUserEmail, // normalized email for consistent lookups
          createdAt: movie.createdAt,
          updatedAt: movie.updatedAt,
        };

        console.log(
          "Adding movie with addedBy:",
          normalizedUserEmail,
          "Integer ID:",
          nextId
        );

        const result = await moviesCollection.insertOne(doc);
        console.log("Inserted movie result:", result?.insertedId);
        res
          .status(201)
          .send({ insertedId: Number(nextId), id: Number(nextId) });
      } catch (error) {
        console.error("Error adding movie:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to add movie" });
      }
    });

    // My collection (protected)
    app.get("/movies/my-collection", requireAuth, async (req, res) => {
      try {
        const userEmail = req.userEmail;
        if (!userEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        const normalizedEmail = (userEmail || "").toLowerCase();
        const emailsToMatch = [
          ...new Set([userEmail, normalizedEmail].filter(Boolean)),
        ];

        console.log(
          "Fetching movies for user:",
          userEmail,
          "(normalized:",
          normalizedEmail,
          ")"
        );
        const movies = await moviesCollection
          .find({ addedBy: { $in: emailsToMatch } })
          .sort({ createdAt: -1 })
          .toArray();

        console.log(`Found ${movies.length} movies for user ${userEmail}`);

        // Convert all movies to use integer IDs
        const convertedMovies = movies
          .map(convertMovieToIntegerId)
          .filter((m) => {
            if (!m || !m._id) {
              console.warn("Filtered out movie without _id:", m);
              return false;
            }
            // Ensure _id is a number
            const id = typeof m._id === "number" ? m._id : parseInt(m._id, 10);
            if (isNaN(id) || id <= 0) {
              console.warn("Filtered out movie with invalid ID:", m._id);
              return false;
            }
            return true;
          })
          .map((m) => {
            // Ensure _id is always a number
            const id = typeof m._id === "number" ? m._id : parseInt(m._id, 10);
            return {
              ...m,
              _id: id,
              id: id,
            };
          });

        console.log(`Returning ${convertedMovies.length} converted movies`);
        res.send(convertedMovies || []);
      } catch (error) {
        console.error("Error fetching my collection:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch collection" });
      }
    });

    // Watchlist - get entries (protected)
    app.get("/watchlist", requireAuth, async (req, res) => {
      try {
        const normalizedEmail = (req.userEmail || "").trim().toLowerCase();
        if (!normalizedEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        const watchlistEntries = await watchlistCollection
          .find({ userEmail: normalizedEmail })
          .sort({ createdAt: -1 })
          .toArray();

        if (!watchlistEntries.length) {
          return res.send([]);
        }

        const numericIds = new Set();
        const stringIds = new Set();

        for (const entry of watchlistEntries) {
          if (
            typeof entry.movieId === "number" &&
            Number.isFinite(entry.movieId) &&
            entry.movieId > 0
          ) {
            numericIds.add(entry.movieId);
          }

          if (entry.movieKey) {
            stringIds.add(String(entry.movieKey));
          }
        }

        const orConditions = [];
        if (numericIds.size) {
          const numericArray = Array.from(numericIds);
          orConditions.push({ id: { $in: numericArray } });
          orConditions.push({ _id: { $in: numericArray } });
        }
        if (stringIds.size) {
          const stringArray = Array.from(stringIds);
          orConditions.push({ _id: { $in: stringArray } });
          orConditions.push({ id: { $in: stringArray } });
        }

        const moviesFromDb = orConditions.length
          ? await moviesCollection.find({ $or: orConditions }).toArray()
          : [];

        const convertedMap = new Map();
        for (const movie of moviesFromDb) {
          const converted = convertMovieToIntegerId(movie);
          if (converted && converted._id) {
            convertedMap.set(String(converted._id), converted);
            convertedMap.set(String(converted.id), converted);
          }
        }

        const response = watchlistEntries
          .map((entry) => {
            const primaryKey = entry.movieKey ? String(entry.movieKey) : "";
            const fallbackKey =
              entry.movieId !== undefined ? String(entry.movieId) : "";
            const movie =
              convertedMap.get(primaryKey) || convertedMap.get(fallbackKey);

            if (!movie) {
              return entry.movieSnapshot
                ? {
                    ...entry.movieSnapshot,
                    _id: entry.movieKey || entry.movieId,
                    id: entry.movieKey || entry.movieId,
                    watchlistedAt: entry.createdAt,
                    isMissing: true,
                  }
                : null;
            }

            return {
              ...movie,
              watchlistedAt: entry.createdAt,
            };
          })
          .filter(Boolean);

        res.send(response);
      } catch (error) {
        console.error("Error fetching watchlist:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch watchlist" });
      }
    });

    // Watchlist - add movie (protected)
    app.post("/watchlist/:movieId", requireAuth, async (req, res) => {
      try {
        const normalizedEmail = (req.userEmail || "").trim().toLowerCase();
        if (!normalizedEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        const { movieId } = req.params;
        const movie = await findMovieByIdentifier(moviesCollection, movieId);

        if (!movie) {
          return res.status(404).send({ message: "Movie not found" });
        }

        const converted = convertMovieToIntegerId(movie);
        if (!converted || !converted._id) {
          return res
            .status(500)
            .send({ message: "Failed to process movie data" });
        }

        const normalizedMovieId = Number(converted.id);
        const movieKey = String(converted.id);

        const existing = await watchlistCollection.findOne({
          userEmail: normalizedEmail,
          movieKey,
        });

        if (existing) {
          return res.status(200).send({
            message: "Movie is already in your watchlist",
            movie: converted,
            alreadyExists: true,
          });
        }

        const entry = {
          userEmail: normalizedEmail,
          movieId: normalizedMovieId,
          movieKey,
          createdAt: new Date(),
          movieSnapshot: {
            id: converted.id,
            _id: converted._id,
            title: converted.title,
            posterUrl: converted.posterUrl,
            genre: converted.genre,
            releaseYear: converted.releaseYear,
            rating: converted.rating,
          },
        };

        await watchlistCollection.insertOne(entry);

        res.status(201).send({
          message: "Movie added to watchlist",
          movie: converted,
        });
      } catch (error) {
        console.error("Error adding to watchlist:", error);
        if (error.code === 11000) {
          return res.status(200).send({
            message: "Movie is already in your watchlist",
            alreadyExists: true,
          });
        }
        res
          .status(500)
          .send({ message: error.message || "Failed to add to watchlist" });
      }
    });

    // Watchlist - remove movie (protected)
    app.delete("/watchlist/:movieId", requireAuth, async (req, res) => {
      try {
        const normalizedEmail = (req.userEmail || "").trim().toLowerCase();
        if (!normalizedEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        const { movieId } = req.params;
        const { numericCandidates, keyCandidates } =
          buildWatchlistIdentifierCandidates(movieId);

        const orConditions = [];
        if (numericCandidates.length) {
          orConditions.push({ movieId: { $in: numericCandidates } });
        }
        if (keyCandidates.length) {
          orConditions.push({ movieKey: { $in: keyCandidates } });
        }

        if (!orConditions.length) {
          return res.status(400).send({ message: "Invalid movie identifier" });
        }

        const result = await watchlistCollection.deleteOne({
          userEmail: normalizedEmail,
          $or: orConditions,
        });

        if (!result.deletedCount) {
          return res
            .status(404)
            .send({ message: "Movie not found in watchlist" });
        }

        res.send({ message: "Movie removed from watchlist" });
      } catch (error) {
        console.error("Error removing from watchlist:", error);
        res
          .status(500)
          .send({
            message: error.message || "Failed to remove from watchlist",
          });
      }
    });

    // Watchlist - status check (protected)
    app.get("/watchlist/status/:movieId", requireAuth, async (req, res) => {
      try {
        const normalizedEmail = (req.userEmail || "").trim().toLowerCase();
        if (!normalizedEmail) {
          return res
            .status(401)
            .send({ message: "Unauthorized: missing user email" });
        }

        const { movieId } = req.params;
        const { numericCandidates, keyCandidates } =
          buildWatchlistIdentifierCandidates(movieId);

        const orConditions = [];
        if (numericCandidates.length) {
          orConditions.push({ movieId: { $in: numericCandidates } });
        }
        if (keyCandidates.length) {
          orConditions.push({ movieKey: { $in: keyCandidates } });
        }

        if (!orConditions.length) {
          return res.send({ isWatchlisted: false });
        }

        const entry = await watchlistCollection.findOne({
          userEmail: normalizedEmail,
          $or: orConditions,
        });

        res.send({ isWatchlisted: !!entry });
      } catch (error) {
        console.error("Error checking watchlist status:", error);
        res
          .status(500)
          .send({
            message: error.message || "Failed to check watchlist status",
          });
      }
    });

    // Movie details (public)
    app.get("/movies/:id", async (req, res) => {
      try {
        const idParam = req.params.id;
        console.log("Fetching movie with ID param:", idParam);

        const movie = await findMovieByIdentifier(moviesCollection, idParam);

        if (!movie) {
          console.log("Movie not found with ID:", idParam);
          return res.status(404).send({ message: "Movie not found" });
        }

        const converted = convertMovieToIntegerId(movie);
        if (!converted || !converted._id) {
          console.error("Error converting movie:", converted);
          return res
            .status(500)
            .send({ message: "Error processing movie data" });
        }

        res.send(converted);
      } catch (error) {
        console.error("Error fetching movie:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch movie" });
      }
    });

    // Update (owner only, protected)
    app.put("/movies/update/:id", requireAuth, async (req, res) => {
      try {
        const idParam = req.params.id;
        const requestorEmail = (req.userEmail || "").toLowerCase();

        const existing = await findMovieByIdentifier(moviesCollection, idParam);

        if (!existing) {
          return res.status(404).send({ message: "Movie not found" });
        }

        const ownerEmail = (existing.addedBy || "").toLowerCase();
        if (ownerEmail !== requestorEmail) {
          return res.status(403).send({ message: "Forbidden: not the owner" });
        }

        const payload = { ...req.body };
        // Never allow changing owner or id
        delete payload.addedBy;
        delete payload._id;
        delete payload.id;

        const updateDoc = {
          $set: {
            ...payload,
            updatedAt: new Date(),
          },
        };

        // Update by id field or _id
        const query = existing.id ? { id: existing.id } : { _id: existing._id };
        const result = await moviesCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        console.error("Error updating movie:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to update movie" });
      }
    });

    // Delete (owner only, protected)
    app.delete("/movies/:id", requireAuth, async (req, res) => {
      try {
        const idParam = req.params.id;
        const requestorEmail = (req.userEmail || "").toLowerCase();

        const existing = await findMovieByIdentifier(moviesCollection, idParam);

        if (!existing) {
          return res.status(404).send({ message: "Movie not found" });
        }

        const ownerEmail = (existing.addedBy || "").toLowerCase();
        if (ownerEmail !== requestorEmail) {
          return res.status(403).send({ message: "Forbidden: not the owner" });
        }

        // Delete by id field or _id
        const query = existing.id ? { id: existing.id } : { _id: existing._id };
        const result = await moviesCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error deleting movie:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to delete movie" });
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
        console.error("Error fetching stats:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch stats" });
      }
    });

    app.get("/home/top-rated", async (_req, res) => {
      try {
        const movies = await moviesCollection
          .find({})
          .sort({ rating: -1 })
          .limit(5)
          .toArray();

        const convertedMovies = movies
          .map(convertMovieToIntegerId)
          .filter((m) => m !== null);
        res.send(convertedMovies);
      } catch (error) {
        console.error("Error fetching top rated:", error);
        res
          .status(500)
          .send({
            message: error.message || "Failed to fetch top rated movies",
          });
      }
    });

    app.get("/home/recent", async (_req, res) => {
      try {
        const recentMoviesCursor = await moviesCollection
          .find({})
          .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
          .limit(12);

        const recentMovies = await recentMoviesCursor.toArray();

        const convertedMovies = recentMovies
          .map((movie) => convertMovieToIntegerId(movie))
          .filter(Boolean)
          .slice(0, 6);

        res.send(convertedMovies);
      } catch (error) {
        console.error("Error fetching recent movies:", error);
        res
          .status(500)
          .send({ message: error.message || "Failed to fetch recent movies" });
      }
    });

    app.get("/home/featured", async (_req, res) => {
      try {
        const movies = await moviesCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        const convertedMovies = movies
          .map(convertMovieToIntegerId)
          .filter((m) => m !== null);
        res.send(convertedMovies);
      } catch (error) {
        console.error("Error fetching featured movies:", error);
        res
          .status(500)
          .send({
            message: error.message || "Failed to fetch featured movies",
          });
      }
    });

    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);

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

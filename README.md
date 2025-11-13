# 🎬 MovieMaster Pro — Backend

**MovieMaster Pro** is the backend service for a modern movie management system.
It powers all core functionalities like user authentication, movie CRUD operations, and secure data handling.

---

## 🌐 Live Server

🔗 **[https://moviemaster-pro-server.vercel.app](https://moviemaster-pro-server.vercel.app)**

---

## 🧠 Overview

MovieMaster Pro Backend provides a RESTful API to manage movies, handle authentication, and serve data to the frontend client.
It’s built using **Node.js**, **Express**, and **MongoDB** with proper routing, environment configuration, and middleware integration.

---

## ✨ Features

* 🔐 Secure Authentication (JWT / Firebase)
* 🎞️ Movie CRUD Operations (Add, Update, Delete, View)
* 👤 User-based Data Access (My Collection)
* 🚦 Middleware Protection for Private Routes
* ⚡ Deployed on Vercel for high availability
* 🧱 Well-structured folder architecture

---

## ⚙️ Tech Stack

* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** MongoDB (Atlas)
* **Hosting:** Vercel
* **Environment Management:** Dotenv
* **CORS Handling:** Cors

---

## 🛠️ Local Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/muhammadMilon/Server_PHA10.git
   cd moviemaster-pro-server
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Create `.env` file**

   ```env
   PORT=5000
   MONGODB_URI=your_mongodb_connection_string
   ACCESS_TOKEN_SECRET=your_jwt_secret
   ```

4. **Run the server**

   ```bash
   npm run dev
   ```

5. The server will start at → `http://localhost:5000`

---

## 🧾 Developer Info

**👨‍💻 Author:** Muhammad Milon
📧 **Email:** [mmilon82814@gmail.com](mailto:mmilon82814@gmail.com)
🌍 **Frontend Repo:** [MovieMaster Pro Client](https://github.com/muhammadMilon/Client_PHA10.git)
🚀 **Live Client:** [https://moviemaster-pro.netlify.app](https://moviemaster-milon.web.app/)

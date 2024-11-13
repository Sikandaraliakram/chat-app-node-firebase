const express = require("express");
const admin = require("firebase-admin");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
// Enable CORS for all origins
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
const port = process.env.PORT || 3000;

// Initialize Firebase
const serviceAccount = require("./serviceAccountKey.json");
initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = getFirestore();

// Create a new collection if it doesn't exist
db.collection("chats").doc("messages").set({
  messages: [],
});

// Middleware
app.use(express.json());

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New client connected");

  socket.on("join chat", (chatId) => {
    socket.join(chatId);
    console.log(`User joined chat: ${chatId}`);
  });

  socket.on("leave chat", (chatId) => {
    socket.leave(chatId);
    console.log(`User left chat: ${chatId}`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

app.post("/messages", async (req, res) => {
  console.log(req.body);
  try {
    const {
      senderId,
      senderName,
      senderProfilePic,
      receiverId,
      receiverName,
      receiverProfilePic,
      message,
      timestamp,
    } = req.body;

    if (
      !senderId ||
      !senderName ||
      !senderProfilePic ||
      !receiverId ||
      !receiverName ||
      !receiverProfilePic ||
      !message ||
      !timestamp
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const chatId = [senderId, receiverId].sort().join("-");
    const chatRoomRef = db.collection("chatRooms").doc(chatId);
    const newMessageRef = chatRoomRef.collection("messages").doc();

    await db.runTransaction(async (transaction) => {
      const chatRoomDoc = await transaction.get(chatRoomRef);

      if (!chatRoomDoc.exists) {
        transaction.set(chatRoomRef, {
          participants: [
            {
              senderId: senderId,
              senderName: senderName,
              senderProfilePic: senderProfilePic,
            },
            {
              receiverId: receiverId,
              receiverName: receiverName,
              receiverProfilePic: receiverProfilePic,
            },
          ],
          lastMessage: message,
          lastMessageTimestamp: timestamp,
        });
      } else {
        transaction.update(chatRoomRef, {
          lastMessage: message,
          lastMessageTimestamp: timestamp,
        });
      }

      transaction.set(newMessageRef, {
        senderId: senderId,
        senderName: senderName,
        senderProfilePic: senderProfilePic,
        message,
        timestamp,
        seen: false,
      });

      // Update user's chat list
      const updateUserChatList = (userId) => {
        const userChatListRef = db
          .collection("users")
          .doc(userId)
          .collection("chatList")
          .doc(chatId);
        transaction.set(
          userChatListRef,
          {
            chatId,
            participants: [
              {
                senderId: senderId,
                senderName: senderName,
                senderProfilePic: senderProfilePic,
              },
              {
                receiverId: receiverId,
                receiverName: receiverName,
                receiverProfilePic: receiverProfilePic,
              },
            ],
            lastMessage: message,
            lastMessageTimestamp: timestamp,
          },
          { merge: true }
        );
      };

      updateUserChatList(senderId, receiverId);
      updateUserChatList(receiverId, senderId);
    });

    // After successfully saving the message
    io.to(chatId).emit("new message", {
      chatId,
      message: {
        id: newMessageRef.id,
        senderId,
        senderName,
        senderProfilePic,
        message,
        timestamp,
        seen: false,
      },
    });

    res.status(200).json({
      status: "success",
      message: "Message sent successfully",
      chatId,
    });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Modify the existing GET messages endpoint to filter out deleted messages
app.get("/messages/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { lastMessageTimestamp, userId } = req.query;
    console.log(chatId);
    if (!userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const messagesRef = db
      .collection("chatRooms")
      .doc(chatId)
      .collection("messages");
    let query = messagesRef.orderBy("timestamp", "desc").limit(50);

    if (lastMessageTimestamp) {
      query = query.where("timestamp", "<", parseInt(lastMessageTimestamp));
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ messages: [] });
    }

    const messages = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter((message) => !message.deletedFor || !message.deletedFor[userId]);

    res.status(200).json({ messages });
  } catch (error) {
    console.error("Error retrieving messages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to mark messages as seen
app.post("/messages/:chatId/seen", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId, lastSeenTimestamp } = req.body;

    if (!userId || !lastSeenTimestamp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const messagesRef = db
      .collection("chatRooms")
      .doc(chatId)
      .collection("messages");
    const batch = db.batch();

    const snapshot = await messagesRef
      .where("timestamp", "<=", lastSeenTimestamp)
      .where("senderId", "!=", userId)
      .where("seen", "==", false)
      .get();

    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { seen: true });
    });

    await batch.commit();

    // After successfully marking messages as seen
    io.to(chatId).emit("messages seen", {
      chatId,
      userId,
      lastSeenTimestamp,
    });

    res
      .status(200)
      .json({ status: "success", message: "Messages marked as seen" });
  } catch (error) {
    console.error("Error marking messages as seen:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to retrieve all chats of a user
app.get("/chats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const userChatsRef = db
      .collection("users")
      .doc(userId)
      .collection("chatList");
    const snapshot = await userChatsRef
      .orderBy("lastMessageTimestamp", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ chats: [] });
    }

    const chats = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ chats });
  } catch (error) {
    console.error("Error getting user chats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to delete a message
app.delete("/messages/:chatId/:messageId", async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const { userId, deleteForEveryone } = req.body;
    console.log(req.params, req.body);
    if (!userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const messageRef = db
      .collection("chatRooms")
      .doc(chatId)
      .collection("messages")
      .doc(messageId);

    const messageDoc = await messageRef.get();

    if (!messageDoc.exists) {
      return res.status(404).json({ error: "Message not found" });
    }

    const messageData = messageDoc.data();
    console.log(messageData);
    if (deleteForEveryone && +messageData.senderId !== +userId) {
      return res
        .status(403)
        .json({ error: "Unauthorized to delete this message for everyone" });
    }

    if (deleteForEveryone) {
      // Delete the message for everyone
      await messageRef.delete();
    } else {
      // Delete the message only for the current user
      await messageRef.update({
        [`deletedFor.${userId}`]: true,
      });
    }

    // After successfully deleting the message
    io.to(chatId).emit("message deleted", {
      chatId,
      messageId,
      deleteForEveryone,
    });

    res
      .status(200)
      .json({ status: "success", message: "Message deleted successfully" });
  } catch (error) {
    console.error("Error deleting message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to delete a chat
app.delete("/chats/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userChatRef = db
      .collection("users")
      .doc(userId)
      .collection("chatList")
      .doc(chatId);

    const userChatDoc = await userChatRef.get();

    if (!userChatDoc.exists) {
      return res.status(404).json({ error: "Chat not found for this user" });
    }

    // Delete chat only for the current user
    await userChatRef.delete();

    // After successfully deleting the chat
    io.to(chatId).emit("chat deleted", {
      chatId,
      deleteForEveryone,
    });

    res
      .status(200)
      .json({ status: "success", message: "Chat deleted successfully" });
  } catch (error) {
    console.error("Error deleting chat:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to delete a collection
async function deleteCollection(db, collectionPath) {
  const collectionRef = db.collection(collectionPath);
  const batch = db.batch();

  const snapshot = await collectionRef.get();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
}

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const express = require("express");
const admin = require("firebase-admin");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
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

// Endpoint to retrieve all messages of a chat
app.get("/messages/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { lastMessageTimestamp } = req.query;

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

    const messages = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

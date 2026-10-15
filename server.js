require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
const mongoose = require('mongoose');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- WEB PUSH SETUP ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BF4tXWDXrSM2FjtV0yGJE0NklMee1RJjgVK7eEmUnNH-uw8Laa9LwgBzSen72pbF517IXaXLNztDMfFv6BGhuqg';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'OWMfovAC5bhwRvU_FJVg852leowrSdAZXviL95zHxoo';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      'mailto:admin@smartqueue.local',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    console.log('✅ Web Push initialized successfully with VAPID keys');
  } catch (err) {
    console.error('❌ Web Push setup error:', err.message);
  }
}


// --- MONGODB SETUP ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const QueueSchema = new mongoose.Schema({
  counterName: { type: String, default: 'Main Admin' },
  currentlyServing: { type: Number, default: 0 },
  currentlyServingName: { type: String, default: '' },
  lastIssuedToken: { type: Number, default: 0 },
  waitingList: { type: mongoose.Schema.Types.Mixed, default: [] }, 
  isPaused: { type: Boolean, default: false }
});
const Queue = mongoose.model('Queue', QueueSchema);

let state = {};

async function loadStateFromDB() {
  let dbState = await Queue.findOne({ counterName: 'Main Admin' });
  if (!dbState) {
    dbState = await Queue.create({ 
      counterName: 'Main Admin', 
      currentlyServing: 0, 
      currentlyServingName: '',
      lastIssuedToken: 0, 
      waitingList: [], 
      isPaused: false 
    });
  }
  state = dbState;
  console.log(`📂 DB Loaded -> Serving: ${state.currentlyServing} (${state.currentlyServingName || 'None'}) | Waiting: ${state.waitingList.length}`);
}
loadStateFromDB();

function getSanitizedState() {
  const safeWaiting = (state.waitingList || []).map(user => {
    if (typeof user === 'object' && user !== null) {
      return { token: user.token, name: user.name || 'Anonymous' };
    }
    return { token: user, name: 'Anonymous' };
  });

  return {
    counterName: state.counterName,
    currentlyServing: state.currentlyServing,
    currentlyServingName: state.currentlyServingName || '',
    lastIssuedToken: state.lastIssuedToken,
    waitingList: safeWaiting,
    isPaused: state.isPaused
  };
}

async function updateDBAndBroadcast() {
  await Queue.findOneAndUpdate(
    { counterName: 'Main Admin' }, 
    { 
      currentlyServing: state.currentlyServing,
      currentlyServingName: state.currentlyServingName,
      lastIssuedToken: state.lastIssuedToken,
      waitingList: state.waitingList,
      isPaused: state.isPaused 
    }
  );
  io.emit('stateUpdated', getSanitizedState());
}

// --- WEBSOCKETS ---
io.on('connection', (socket) => {
  socket.emit('stateUpdated', getSanitizedState()); 

  socket.on('adminPause', async () => {
    state.isPaused = true;
    await updateDBAndBroadcast();
  });

  socket.on('adminResume', async () => {
    state.isPaused = false;
    await updateDBAndBroadcast();
  });

  socket.on('adminBump', async () => {
    if (state.currentlyServing > 0 && state.waitingList.length > 0) {
      const bumpedUser = {
        token: state.currentlyServing,
        name: state.currentlyServingName,
        subscription: null 
      };

      const nextUser = state.waitingList.shift();
      state.currentlyServing = nextUser.token;
      state.currentlyServingName = nextUser.name || 'Anonymous';

      const insertIndex = Math.min(2, state.waitingList.length);
      state.waitingList.splice(insertIndex, 0, bumpedUser);

      console.log(`⚠️ Token ${bumpedUser.token} (${bumpedUser.name}) bumped to position ${insertIndex + 1}.`);
      sendTurnNotification(nextUser);
      await updateDBAndBroadcast();
    }
  });
});

async function sendTurnNotification(user) {
  if (!user || !user.subscription || !VAPID_PUBLIC_KEY) return;
  const payload = JSON.stringify({ 
    title: "It's your turn!", 
    body: `${user.name || 'Student'} (Token ${user.token}), please proceed to the counter.`,
    url: '/mobile.html'
  });
  try {
    await webpush.sendNotification(user.subscription, payload);
    console.log(`📢 Web push notification successfully sent to Token ${user.token} (${user.name})`);
  } catch (err) {
    console.error(`❌ Push notification failed for Token ${user.token}:`, err.message);
  }
}

// --- API 0: GET VAPID PUBLIC KEY ---
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// --- API 1: JOIN QUEUE (With Name + Optional Subscription) ---
app.post('/join', async (req, res) => {
  if (state.isPaused) return res.status(403).json({ message: "Queue is paused." });

  const customerName = (req.body.name || '').trim() || 'Student';
  const subscription = req.body.subscription || null;

  state.lastIssuedToken++;
  const myToken = state.lastIssuedToken;

  const newUser = {
    token: myToken,
    name: customerName,
    subscription: subscription
  };

  state.waitingList.push(newUser);

  let peopleAhead = state.waitingList.length - 1;

  if (state.currentlyServing === 0) {
    const active = state.waitingList.shift();
    state.currentlyServing = active.token;
    state.currentlyServingName = active.name;
    peopleAhead = -1;
    // User is served immediately
    sendTurnNotification(active);
  }

  console.log(`📱 Token ${myToken} (${customerName}) joined with ${subscription ? 'push enabled' : 'no push'}. Total waiting: ${state.waitingList.length}`);
  await updateDBAndBroadcast();

  res.status(200).json({ 
    token: myToken, 
    name: customerName,
    peopleAhead: peopleAhead 
  });
});

// --- API 2: UPDATE / LINK PUSH SUBSCRIPTION ---
app.post('/subscribe', async (req, res) => {
  const { token, subscription } = req.body;
  if (!token || !subscription) {
    return res.status(400).json({ message: "Token and subscription are required." });
  }

  const user = (state.waitingList || []).find(u => u.token === parseInt(token));
  if (user) {
    user.subscription = subscription;
    await updateDBAndBroadcast();
    console.log(`🔔 Updated push subscription for Token ${token}`);
    return res.json({ success: true, message: "Subscription attached to queue token." });
  }

  res.status(404).json({ message: "Token not found in waiting queue." });
});

// --- API 3: TEST PUSH NOTIFICATION ---
app.post('/test-notification', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !VAPID_PUBLIC_KEY) {
    return res.status(400).json({ message: "Subscription or VAPID key is missing." });
  }

  try {
    const payload = JSON.stringify({
      title: "Smart Queue Test Alert",
      body: "Notifications are working! You will be alerted when it's your turn.",
      url: '/mobile.html'
    });
    await webpush.sendNotification(subscription, payload);
    res.json({ success: true, message: "Test notification sent successfully." });
  } catch (err) {
    console.error("Test notification delivery error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API 4: MAT / MANUAL INCREMENT ---
app.post('/increment', async (req, res) => {
  if (state.isPaused) return res.status(403).json({ message: "Queue is paused." });

  if (state.waitingList.length > 0) {
    const nextUser = state.waitingList.shift(); 
    state.currentlyServing = nextUser.token;
    state.currentlyServingName = nextUser.name || 'Student';
    console.log(`🔔 BING! Calling Token: ${state.currentlyServing} (${state.currentlyServingName})`);

    sendTurnNotification(nextUser);
  } else {
    state.currentlyServing = 0;
    state.currentlyServingName = '';
    console.log(`🔔 Mat triggered, queue is empty.`);
  }

  await updateDBAndBroadcast();
  res.status(200).json({ 
    message: "Success", 
    serving: state.currentlyServing,
    servingName: state.currentlyServingName 
  });
});

app.use(express.static(__dirname));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Smart Server running on port ${PORT}...`);
});
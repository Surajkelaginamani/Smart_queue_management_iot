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
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@smartqueue.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
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
      await updateDBAndBroadcast();
    }
  });
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
  }

  console.log(`📱 Token ${myToken} (${customerName}) joined. Total waiting: ${state.waitingList.length}`);
  await updateDBAndBroadcast();

  res.status(200).json({ 
    token: myToken, 
    name: customerName,
    peopleAhead: peopleAhead 
  });
});

// --- API 2: MAT / MANUAL INCREMENT ---
app.post('/increment', async (req, res) => {
  if (state.isPaused) return res.status(403).json({ message: "Queue is paused." });

  if (state.waitingList.length > 0) {
    const nextUser = state.waitingList.shift(); 
    state.currentlyServing = nextUser.token;
    state.currentlyServingName = nextUser.name || 'Student';
    console.log(`🔔 BING! Calling Token: ${state.currentlyServing} (${state.currentlyServingName})`);

    if (nextUser.subscription && process.env.VAPID_PUBLIC_KEY) {
      const payload = JSON.stringify({ 
        title: "It's your turn!", 
        body: `${state.currentlyServingName} (Token ${nextUser.token}), please proceed to the counter.` 
      });
      webpush.sendNotification(nextUser.subscription, payload)
        .catch(err => console.error("Push Notification Delivery Note:", err.message));
    }
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
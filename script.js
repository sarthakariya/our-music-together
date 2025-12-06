// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- ALWAYS ASK NAME (No LocalStorage) ---
let myName = prompt("Welcome! Please enter your name (e.g., Sarthak or Reechita):");
if (!myName || myName.trim() === "") {
    myName = "Mystery Guest";
}

// --- NEW DATABASE PATHS (GLOBAL SYNC) ---
// We no longer sync to "users/name". We sync to "server/global".
// This ensures 100% sync regardless of names.
const queueRef = db.ref('server/queue');
const globalSyncRef = db.ref('server/playbackState');
const chatRef = db.ref('server/chat');

// Global State
let player; 
let currentQueue = [];
let currentVideoId = null;
let lastServerState = null;
let isInternalUpdate = false; // Flag to prevent loops

// --- VISUAL EFFECTS ---
function createParticles() {
    const container = document.getElementById('particles-container');
    const particleCount = 20; 
    for(let i=0; i<particleCount; i++) {
        setTimeout(() => {
            const el = document.createElement('i');
            el.className = 'fa-solid fa-heart heart-particle';
            el.style.left = Math.random() * 100 + '%';
            el.style.fontSize = (Math.random() * 20 + 10) + 'px';
            el.style.animationDuration = (Math.random() * 3 + 4) + 's';
            container.appendChild(el);
            // Remove after animation to prevent memory leak
            setTimeout(() => el.remove(), 7000);
        }, i * 300);
    }
    // Repeat loop
    setInterval(createParticles, 8000);
}
createParticles();

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '', 
        playerVars: { 'controls': 0, 'disablekb': 1, 'rel': 0, 'modestbranding': 1, 'origin': window.location.origin },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(80);
    
    // Listen for Global Changes
    listenToFirebase();
    
    // Heartbeat to check if song ended
    setInterval(() => {
        if(player && player.getPlayerState() === YT.PlayerState.PLAYING) {
            const cur = player.getCurrentTime();
            const dur = player.getDuration();
            if(dur > 0 && dur - cur < 1) {
                playNextSong();
            }
        }
    }, 1000);
}

function onPlayerStateChange(event) {
    // If this change came from our code (isInternalUpdate), ignore it
    if(isInternalUpdate) return;

    // Otherwise, the user clicked something in the video (if controls were enabled)
    // or the video buffered naturally.
    if(event.data === YT.PlayerState.PLAYING) {
        broadcastState('play', player.getCurrentTime());
    } else if (event.data === YT.PlayerState.PAUSED) {
        broadcastState('pause', player.getCurrentTime());
    }
}

// ------------------------------------------------------------------------------------------------------
// --- SYNC LOGIC (THE 100% FIX) ---
// ------------------------------------------------------------------------------------------------------

function listenToFirebase() {
    // 1. SYNC LISTENER
    globalSyncRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if(!state) return;
        
        lastServerState = state;
        
        // Update Title UI
        if(currentVideoId !== state.videoId) {
            // Find song title
            const song = currentQueue.find(s => s.videoId === state.videoId);
            document.getElementById('current-song-title').textContent = song ? song.title : "Syncing...";
        }

        // Apply State
        applyServerState(state);
    });

    // 2. QUEUE LISTENER
    queueRef.on('value', (snapshot) => {
        const data = snapshot.val();
        currentQueue = [];
        if(data) {
            Object.keys(data).forEach(key => currentQueue.push({...data[key], key: key}));
        }
        currentQueue.sort((a,b) => (a.order||0) - (b.order||0));
        renderQueue();
    });

    // 3. CHAT LISTENER
    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        renderMessage(msg);
    });
}

function broadcastState(status, time) {
    if(!currentVideoId) return;
    
    // We update the server. Everyone (including us) will receive the update.
    globalSyncRef.set({
        status: status, // 'play' or 'pause'
        time: time,
        videoId: currentVideoId,
        lastUpdater: myName,
        timestamp: Date.now()
    });
}

function applyServerState(state) {
    if(!player || !player.loadVideoById) return;

    // Prevent loop: If I just updated it less than 500ms ago, ignore
    const now = Date.now();
    if(state.lastUpdater === myName && (now - state.timestamp < 500)) {
        return;
    }

    isInternalUpdate = true; // Don't trigger 'onStateChange' loop

    // 1. Check Video
    if(currentVideoId !== state.videoId) {
        currentVideoId = state.videoId;
        player.loadVideoById(state.videoId, state.time);
        if(state.status === 'pause') {
            player.pauseVideo();
        }
    } else {
        // 2. Check Time Drift (> 2 seconds)
        const localTime = player.getCurrentTime();
        if(Math.abs(localTime - state.time) > 2) {
            player.seekTo(state.time, true);
        }
    }

    // 3. Check Play/Pause
    const playerState = player.getPlayerState();
    if(state.status === 'play' && playerState !== YT.PlayerState.PLAYING) {
        player.playVideo();
        updatePlayBtn(true);
    } else if(state.status === 'pause' && playerState !== YT.PlayerState.PAUSED) {
        player.pauseVideo();
        updatePlayBtn(false);
    } else if (state.status === 'play') {
        updatePlayBtn(true);
    } else {
        updatePlayBtn(false);
    }

    // Reset flag after a moment
    setTimeout(() => { isInternalUpdate = false; }, 500);
}

// ------------------------------------------------------------------------------------------------------
// --- CONTROLS ---
// ------------------------------------------------------------------------------------------------------

document.getElementById('play-pause-btn').addEventListener('click', () => {
    if(!player) return;
    const state = player.getPlayerState();
    if(state === YT.PlayerState.PLAYING) {
        broadcastState('pause', player.getCurrentTime());
    } else {
        if(!currentVideoId && currentQueue.length > 0) {
            // Start queue
            currentVideoId = currentQueue[0].videoId;
            broadcastState('play', 0);
        } else {
            broadcastState('play', player.getCurrentTime());
        }
    }
});

document.getElementById('next-btn').addEventListener('click', playNextSong);
document.getElementById('prev-btn').addEventListener('click', playPreviousSong);

function playNextSong() {
    if(currentQueue.length === 0) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const nextIdx = (idx + 1) % currentQueue.length;
    currentVideoId = currentQueue[nextIdx].videoId;
    broadcastState('play', 0);
}

function playPreviousSong() {
    if(currentQueue.length === 0) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    let prevIdx = idx - 1;
    if(prevIdx < 0) prevIdx = currentQueue.length - 1;
    currentVideoId = currentQueue[prevIdx].videoId;
    broadcastState('play', 0);
}

function updatePlayBtn(isPlaying) {
    const btn = document.getElementById('play-pause-btn');
    const msg = document.getElementById('sync-status-msg');
    if(isPlaying) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        msg.innerHTML = '<i class="fa-solid fa-heart pulse-heart"></i> SYNCED LISTENING';
        msg.style.color = '#c252e1';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        msg.innerHTML = '<i class="fa-solid fa-pause"></i> PAUSED';
        msg.style.color = '#aaa';
    }
}

// ------------------------------------------------------------------------------------------------------
// --- SEARCH, PLAYLISTS & SPOTIFY ---
// ------------------------------------------------------------------------------------------------------

async function handleSearchAndLinks() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if(!query) return;

    document.getElementById('results-list').innerHTML = '<div class="empty-state">Searching...</div>';
    switchTab('results');

    // 1. Check for Spotify Link
    if(query.includes('spotify.com')) {
        await fetchSpotifyData(query);
        input.value = '';
        return;
    }

    // 2. Check for YouTube Playlist
    if(query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        await fetchPlaylist(listId);
        input.value = '';
        return;
    }

    // 3. Regular Search
    const results = await searchYouTube(query);
    renderSearchResults(results);
    input.value = '';
}

// API Functions
async function searchYouTube(q) {
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        if(data.error) return [];
        return data.items.map(i => ({
            videoId: i.id.videoId, title: i.snippet.title,
            uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url
        }));
    } catch(e) { console.error(e); return []; }
}

async function fetchPlaylist(listId, pageToken='') {
    const status = document.getElementById('results-list');
    status.innerHTML = '<div class="empty-state">Fetching playlist...</div>';
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`);
        const data = await res.json();
        if(data.items) {
            const songs = data.items.map(i => ({
                videoId: i.snippet.resourceId.videoId, title: i.snippet.title,
                uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url
            }));
            addBatchToQueue(songs);
            status.innerHTML = `<div class="empty-state">Added ${songs.length} songs!</div>`;
            setTimeout(() => switchTab('queue'), 1500);
        }
    } catch(e) { console.error(e); }
}

async function fetchSpotifyData(link) {
    const status = document.getElementById('results-list');
    status.innerHTML = '<div class="empty-state">Decoding Spotify Link...</div>';
    try {
        const res = await fetch(`https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;
        const data = await res.json();
        if(data.tracks) {
            status.innerHTML = `<div class="empty-state">Found ${data.tracks.length} tracks. Matching with YouTube...</div>`;
            // Search first 20 to avoid rate limits
            const limited = data.tracks.slice(0, 20); 
            for(let t of limited) {
                const results = await searchYouTube(`${t.artist} - ${t.title}`);
                if(results.length > 0) addToQueue(results[0], true);
            }
            setTimeout(() => switchTab('queue'), 2000);
        }
    } catch(e) { 
        status.innerHTML = '<div class="empty-state">Error fetching Spotify data.</div>';
    }
}

// ------------------------------------------------------------------------------------------------------
// --- QUEUE MANAGEMENT ---
// ------------------------------------------------------------------------------------------------------

function addToQueue(song, silent=false) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ ...song, order: Date.now() });
    if(!silent) {
        switchTab('queue');
        if(!currentVideoId) { // Auto play if empty
            currentVideoId = song.videoId;
            broadcastState('play', 0);
        }
    }
}

function addBatchToQueue(songs) {
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, order: Date.now() + i };
    });
    queueRef.update(updates);
    if(!currentVideoId && songs.length > 0) {
        currentVideoId = songs[0].videoId;
        broadcastState('play', 0);
    }
}

function removeFromQueue(key) {
    queueRef.child(key).remove();
}

function renderQueue() {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    document.getElementById('queue-count').textContent = currentQueue.length;

    if(currentQueue.length === 0) {
        list.innerHTML = '<div class="empty-state">Queue is empty.</div>';
        return;
    }

    currentQueue.forEach(s => {
        const el = document.createElement('div');
        el.className = `song-item ${s.videoId === currentVideoId ? 'playing' : ''}`;
        el.innerHTML = `
            <img src="${s.thumbnail}" class="thumb">
            <div class="meta"><h4>${s.title}</h4></div>
            <button class="add-btn" onclick="removeFromQueue('${s.key}')"><i class="fa-solid fa-trash"></i></button>
        `;
        el.onclick = (e) => {
            if(!e.target.closest('.add-btn')) {
                currentVideoId = s.videoId;
                broadcastState('play', 0);
            }
        };
        list.appendChild(el);
    });
}

function renderSearchResults(results) {
    const list = document.getElementById('results-list');
    list.innerHTML = '';
    if(results.length === 0) { list.innerHTML = '<div class="empty-state">No results.</div>'; return; }
    
    results.forEach(s => {
        const el = document.createElement('div');
        el.className = 'song-item';
        el.innerHTML = `
            <img src="${s.thumbnail}" class="thumb">
            <div class="meta"><h4>${s.title}</h4></div>
            <button class="add-btn" onclick='addToQueue(${JSON.stringify(s)})'><i class="fa-solid fa-plus"></i></button>
        `;
        list.appendChild(el);
    });
}

// ------------------------------------------------------------------------------------------------------
// --- CHAT ---
// ------------------------------------------------------------------------------------------------------

document.getElementById('chatSendBtn').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keypress', (e) => { if(e.key==='Enter') sendChat(); });

function sendChat() {
    const input = document.getElementById('chatInput');
    const txt = input.value.trim();
    if(!txt) return;
    
    chatRef.push({ user: myName, text: txt, timestamp: Date.now() });
    input.value = '';
}

function renderMessage(msg) {
    const box = document.getElementById('chat-messages');
    const div = document.createElement('div');
    const isMe = msg.user === myName;
    
    div.className = `chat-message ${isMe ? 'me' : 'other'}`;
    div.innerHTML = `<span class="chat-name">${msg.user}</span>${msg.text}`;
    
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// UI Tabs
function switchTab(t) {
    document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(e => e.classList.remove('active'));
    document.getElementById(`tab-${t}`).classList.add('active');
    document.getElementById(`${t}-list`).classList.add('active');
    
    document.getElementById('search-container').style.display = (t === 'results') ? 'flex' : 'none';
}

document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearchAndLinks(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    if(player) player.playVideo();
});

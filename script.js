// ================= FIREBASE CONFIG =================
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const sessionRef = db.ref('session_v3'); // Fresh session node
const presenceRef = db.ref('connected_users');

// ================= VARIABLES =================
let player;
let queue = [];
let currentIndex = 0;
let myId = Date.now().toString(); // Simple unique ID
let isMaster = false;
let masterId = null;
let searchTimeout = null; // For debouncing
let lastServerTime = 0;

// ================= YOUTUBE API =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%',
        videoId: 'bTqVqk7FSmY', // Default init video
        playerVars: { 'playsinline': 1, 'controls': 0, 'disablekb': 1, 'fs': 0, 'rel': 0 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    console.log("Player Ready");
    // Register presence
    presenceRef.child(myId).set({ online: true, timestamp: firebase.database.ServerValue.TIMESTAMP });
    presenceRef.child(myId).onDisconnect().remove();
    
    startSyncListener();
    
    // UI Loop (Smooth Seek Bar)
    setInterval(updateLocalUI, 500);
    // Master Status Loop
    setInterval(broadcastMasterStatus, 1000);
}

// ================= SYNC LOGIC (MASTER IS TRUTH) =================

function onPlayerStateChange(e) {
    if (e.data === 0) playNext(); // Song ended
}

function broadcastMasterStatus() {
    if (!isMaster || !player) return;

    const currentTime = player.getCurrentTime();
    const state = player.getPlayerState();

    // AD DETECTION: If player is stuck (buffering or ad)
    // We send specific flags so clients know to wait
    let isInterrupted = (state === 3 || state === -1); 
    
    // Safety check: If playing but time not moving, it's an ad
    if (state === 1 && Math.abs(currentTime - lastServerTime) < 0.1) {
        isInterrupted = true;
    }
    lastServerTime = currentTime;

    sessionRef.update({
        timestamp: currentTime,
        status: isInterrupted ? 'interrupted' : (state === 1 ? 'playing' : 'paused'),
        master: myId
    });
}

function startSyncListener() {
    sessionRef.on('value', snap => {
        const data = snap.val();
        
        // --- 1. Master Election (Auto) ---
        if (!data || !data.master) {
            sessionRef.update({ master: myId }); // Claim it
            return;
        }
        
        masterId = data.master;
        // If I am master, I don't listen to DB for playback, I write to it.
        // BUT if the DB says master is someone else, I become a viewer.
        // Logic: First person to join or claim becomes master.
        if (masterId === myId) {
            isMaster = true;
            document.getElementById('connection-status').innerHTML = '<span class="dot" style="background:#e100ff"></span> You are the Vibe Master';
        } else {
            isMaster = false;
            document.getElementById('connection-status').innerHTML = '<span class="dot"></span> Synced with Partner';
        }

        // --- 2. Queue Sync ---
        const newQueue = data.queue || [];
        const newIndex = data.index || 0;
        
        // Only update DOM if queue changed
        if (JSON.stringify(queue) !== JSON.stringify(newQueue) || currentIndex !== newIndex) {
            queue = newQueue;
            currentIndex = newIndex;
            renderQueue();
            loadCurrentSong();
        }

        // --- 3. Playback Sync (Viewers Only) ---
        if (!isMaster && queue.length > 0) {
            const serverTime = data.timestamp || 0;
            const serverStatus = data.status;

            // AD / INTERRUPTION HANDLING
            if (serverStatus === 'interrupted') {
                document.getElementById('syncOverlay').classList.add('active');
                player.pauseVideo();
            } else {
                document.getElementById('syncOverlay').classList.remove('active');
                
                // Normal Sync
                if (serverStatus === 'playing') {
                    if (player.getPlayerState() !== 1) player.playVideo();
                    document.getElementById('music-disc').classList.remove('paused');
                    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-pause"></i>';
                } else {
                    player.pauseVideo();
                    document.getElementById('music-disc').classList.add('paused');
                    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-play"></i>';
                }

                // Time Drift Correction
                if (Math.abs(player.getCurrentTime() - serverTime) > 3) {
                    player.seekTo(serverTime, true);
                }
            }
        }
    });
}

function loadCurrentSong() {
    if (queue.length === 0) return;
    const song = queue[currentIndex];
    
    // Only load if ID changed
    if (player.getVideoData().video_id !== song.id) {
        player.loadVideoById(song.id);
        document.getElementById('current-song-title').innerText = song.title;
        document.getElementById('album-art').style.backgroundImage = `url('${song.thumb}')`;
    }
}

// ================= CONTROLS (COLLABORATIVE) =================
// Anyone can trigger these updates

function togglePlay() {
    if (queue.length === 0) return;
    // We toggle local state first for instant feel, then update DB
    // Ideally, we just check current state and flip it in DB
    sessionRef.once('value', snap => {
        const status = snap.val()?.status;
        const newStatus = (status === 'playing') ? 'paused' : 'playing';
        sessionRef.update({ status: newStatus });
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    if(isMaster) sessionRef.update({ timestamp: newTime }); // Only master pushes time
}

function playNext() {
    if (currentIndex < queue.length - 1) {
        sessionRef.update({ index: currentIndex + 1, timestamp: 0, status: 'playing' });
    }
}

function playPrev() {
    if (currentIndex > 0) {
        sessionRef.update({ index: currentIndex - 1, timestamp: 0, status: 'playing' });
    }
}

// FORCE SKIP AD (The Magic Button)
function forceSyncResume() {
    // This forces the status to playing and jumps forward 1 second
    // Use this if stuck on an ad
    sessionRef.update({ 
        status: 'playing',
        timestamp: player.getCurrentTime() + 1 
    });
    document.getElementById('syncOverlay').classList.remove('active');
}

// ================= SEARCH & PLAYLIST LOGIC =================

// Smart Search with DEBOUNCE (Saves Quota)
document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value;
    
    if (query.length > 0) {
        searchTimeout = setTimeout(() => {
            handleSearch(query);
        }, 1000); // Waits 1 second after you stop typing
    }
});

async function handleSearch(query) {
    // 1. Check if it's a Playlist URL
    if (query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        return;
    }
    
    // 2. Standard Search
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${query}&type=video&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        const list = document.getElementById('results-list');
        list.innerHTML = '';
        
        if (data.error) {
            list.innerHTML = `<div class="empty-state">⚠️ API Error: ${data.error.message}</div>`;
            return;
        }

        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="thumb">
                <div class="meta">
                    <h4>${item.snippet.title}</h4>
                    <p>${item.snippet.channelTitle}</p>
                </div>
                <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
        
        switchTab('results');
    } catch (e) {
        console.error(e);
    }
}

async function fetchPlaylist(listId) {
    // Fetches first 20 items of a playlist
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20&playlistId=${listId}&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.items) {
        const newSongs = data.items.map(item => ({
            id: item.snippet.resourceId.videoId,
            title: item.snippet.title,
            thumb: item.snippet.thumbnails.default.url
        }));
        
        // Add all to queue
        const updatedQueue = [...queue, ...newSongs];
        sessionRef.update({ queue: updatedQueue });
        
        // If queue was empty, start playing
        if (queue.length === 0) {
            sessionRef.update({ index: 0, status: 'playing' });
        }
        
        document.getElementById('searchInput').value = '';
        switchTab('queue');
    }
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { id, title, thumb }];
    sessionRef.update({ queue: newQueue });
    
    if (queue.length === 0) {
        sessionRef.update({ index: 0, status: 'playing' });
    }
    
    document.getElementById('searchInput').value = '';
    switchTab('queue');
}

// ================= UI HELPERS =================

function renderQueue() {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-count').innerText = `${queue.length} Songs`;
    list.innerHTML = '';
    
    if (queue.length === 0) {
        list.innerHTML = '<div class="empty-state">Queue is empty 🎵</div>';
        return;
    }

    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = `song-item ${idx === currentIndex ? 'playing' : ''}`;
        div.innerHTML = `
            <img src="${song.thumb}" class="thumb">
            <div class="meta">
                <h4>${song.title}</h4>
            </div>
            <button onclick="deleteSong(event, ${idx})" class="del-btn"><i class="fa-solid fa-xmark"></i></button>
        `;
        div.onclick = (e) => {
            if(!e.target.closest('.del-btn')) sessionRef.update({ index: idx, status: 'playing', timestamp: 0 });
        }
        list.appendChild(div);
    });
}

function deleteSong(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIndex = currentIndex;
    if (idx < currentIndex) newIndex--;
    sessionRef.update({ queue: newQueue, index: Math.max(0, newIndex) });
}

function clearQueue() {
    if(confirm("Clear everything?")) sessionRef.update({ queue: [], index: 0, status: 'paused' });
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(l => l.classList.remove('active'));
    
    if(tab === 'queue') {
        document.querySelector('.tab:first-child').classList.add('active');
        document.getElementById('queue-list').classList.add('active');
    } else {
        document.querySelector('.tab:last-child').classList.add('active');
        document.getElementById('results-list').classList.add('active');
    }
}

// Local UI Update (Smooth Seek)
function updateLocalUI() {
    if (!player) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if (d) {
        document.getElementById('seek-bar').value = (c / d) * 100;
        document.getElementById('current-time').innerText = formatTime(c);
        document.getElementById('duration').innerText = formatTime(d);
    }
}

document.getElementById('seek-bar').addEventListener('change', (e) => {
    const time = (e.target.value / 100) * player.getDuration();
    player.seekTo(time, true);
    if(isMaster) sessionRef.update({ timestamp: time });
});

// Volume (Local Only)
document.getElementById('volume-bar').addEventListener('input', (e) => {
    player.setVolume(e.target.value);
});

function formatTime(s) {
    return (s - (s %= 60)) / 60 + (9 < s ? ':' : ':0') + Math.floor(s);
}

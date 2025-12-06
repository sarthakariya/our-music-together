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

// --- NAME & GLOBAL REFS ---
let myName = prompt("Deep Space Sync\nPlease enter your name (Sarthak or Reechita):");
if (!myName || myName.trim() === "") myName = "Partner";

// Using a unified server path so sync works regardless of login name
const serverRef = db.ref('server');
const queueRef = serverRef.child('queue');
const playbackRef = serverRef.child('playback');
const chatRef = serverRef.child('chat');
const likeRef = serverRef.child('likes');

// State
let player; 
let currentQueue = [];
let currentVideoId = null;
let isInternalUpdate = false; 

// --- PARTICLES ANIMATION ---
function initParticles() {
    const container = document.getElementById('particles-container');
    if(!container) return;
    setInterval(() => {
        const el = document.createElement('i');
        el.className = 'fa-solid fa-heart heart-particle';
        el.style.left = Math.random() * 100 + '%';
        el.style.fontSize = (Math.random() * 20 + 10) + 'px';
        el.style.animationDuration = (Math.random() * 3 + 4) + 's';
        container.appendChild(el);
        setTimeout(() => el.remove(), 7000);
    }, 800);
}
initParticles();

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER (With Controls Enabled) ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '', 
        playerVars: { 
            'controls': 1, // ENABLED: This allows you to seek/"faster" the song
            'disablekb': 0, 
            'rel': 0, 
            'modestbranding': 1, 
            'autoplay': 1,
            'origin': window.location.origin 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(90);
    setupFirebaseListeners();
    
    // Watch for song end
    setInterval(() => {
        if(player && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING) {
            const cur = player.getCurrentTime();
            const dur = player.getDuration();
            if(dur > 0 && dur - cur < 1) playNextSong();
        }
    }, 1000);
}

// When you drag the seek bar or pause, this triggers
function onPlayerStateChange(event) {
    if(isInternalUpdate) return; // Don't broadcast if WE caused the change

    const state = event.data;
    const time = player.getCurrentTime();

    if(state === YT.PlayerState.PLAYING) {
        broadcastState('play', time);
    } else if (state === YT.PlayerState.PAUSED) {
        broadcastState('pause', time);
    }
}

// ------------------------------------------------------------------------------------------------------
// --- SYNC ENGINE ---
// ------------------------------------------------------------------------------------------------------

function setupFirebaseListeners() {
    // 1. Playback Sync
    playbackRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if(!data) return;
        
        // Update Title UI
        if(currentVideoId !== data.videoId) {
            const song = currentQueue.find(s => s.videoId === data.videoId);
            document.getElementById('current-song-title').textContent = song ? song.title : "Syncing...";
            
            // Check if this song is "Liked"
            checkIfLiked(data.videoId);
        }
        
        applyPlaybackState(data);
    });

    // 2. Queue
    queueRef.on('value', (snapshot) => {
        const data = snapshot.val();
        currentQueue = [];
        if(data) Object.keys(data).forEach(k => currentQueue.push({...data[k], key: k}));
        currentQueue.sort((a,b) => a.order - b.order);
        renderQueue();
    });

    // 3. Chat
    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        renderMessage(snapshot.val());
    });

    // 4. Likes
    likeRef.on('value', (snapshot) => {
        const likes = snapshot.val() || {};
        const btn = document.getElementById('like-btn');
        if(currentVideoId && likes[currentVideoId]) {
            btn.classList.add('liked');
            btn.innerHTML = '<i class="fa-solid fa-heart"></i>';
        } else {
            btn.classList.remove('liked');
            btn.innerHTML = '<i class="fa-regular fa-heart"></i>';
        }
    });
}

function broadcastState(status, time) {
    if(!currentVideoId) return;
    playbackRef.set({
        status: status,
        time: time,
        videoId: currentVideoId,
        timestamp: Date.now(),
        updater: myName
    });
}

function applyPlaybackState(data) {
    if(!player || !player.loadVideoById) return;
    
    // Prevent feedback loops
    if(data.updater === myName && (Date.now() - data.timestamp < 1000)) return;

    isInternalUpdate = true; // Silence the listener while we programmatically change things

    // Change Video?
    if(currentVideoId !== data.videoId) {
        currentVideoId = data.videoId;
        player.loadVideoById(data.videoId, data.time);
        if(data.status === 'pause') player.pauseVideo();
    } else {
        // Just Seek?
        const diff = Math.abs(player.getCurrentTime() - data.time);
        if(diff > 2) player.seekTo(data.time, true);
    }

    // Play/Pause?
    const pState = player.getPlayerState();
    if(data.status === 'play' && pState !== YT.PlayerState.PLAYING) {
        player.playVideo();
    } else if (data.status === 'pause' && pState !== YT.PlayerState.PAUSED) {
        player.pauseVideo();
    }

    updateControlsUI(data.status === 'play');
    
    setTimeout(() => { isInternalUpdate = false; }, 1000);
}

// ------------------------------------------------------------------------------------------------------
// --- CONTROLS & LOGIC ---
// ------------------------------------------------------------------------------------------------------

document.getElementById('play-pause-btn').addEventListener('click', () => {
    if(!player) return;
    const state = player.getPlayerState();
    if(state === YT.PlayerState.PLAYING) {
        broadcastState('pause', player.getCurrentTime());
    } else {
        if(!currentVideoId && currentQueue.length > 0) {
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

function updateControlsUI(isPlaying) {
    const btn = document.getElementById('play-pause-btn');
    const msg = document.getElementById('sync-status-msg');
    if(isPlaying) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        msg.innerHTML = '<i class="fa-solid fa-heart pulse-heart"></i> SYNCED';
        msg.style.color = '#c252e1';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        msg.innerHTML = '<i class="fa-solid fa-pause"></i> PAUSED';
        msg.style.color = '#aaa';
    }
}

// Like Button Logic
document.getElementById('like-btn').addEventListener('click', () => {
    if(!currentVideoId) return;
    const btn = document.getElementById('like-btn');
    const isLiked = btn.classList.contains('liked');
    
    if(isLiked) {
        likeRef.child(currentVideoId).remove();
    } else {
        likeRef.child(currentVideoId).set(true);
    }
});

function checkIfLiked(videoId) {
    likeRef.child(videoId).once('value').then(snap => {
        const btn = document.getElementById('like-btn');
        if(snap.exists()) {
            btn.classList.add('liked');
            btn.innerHTML = '<i class="fa-solid fa-heart"></i>';
        } else {
            btn.classList.remove('liked');
            btn.innerHTML = '<i class="fa-regular fa-heart"></i>';
        }
    });
}

// ------------------------------------------------------------------------------------------------------
// --- SEARCH, QUEUE, CHAT ---
// ------------------------------------------------------------------------------------------------------

// 1. Switch Tabs (Expose to window so HTML onclick works)
window.switchTab = function(tab) {
    document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(e => e.classList.remove('active'));
    
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`${tab}-list`).classList.add('active');
    
    // Toggle Search Bar visibility
    const searchWrap = document.getElementById('search-container');
    searchWrap.style.display = (tab === 'results') ? 'flex' : 'none';
}

// 2. Search
document.getElementById('search-btn').addEventListener('click', performSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') performSearch(); });

async function performSearch() {
    const q = document.getElementById('searchInput').value.trim();
    if(!q) return;
    
    const list = document.getElementById('results-list');
    list.innerHTML = '<div class="empty-state">Searching...</div>';
    
    // Check for Playlist
    if(q.includes('list=')) {
        const listId = q.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        return;
    }
    
    // Check for Spotify (Simple Alert fallback if proxy fails)
    if(q.includes('spotify.com')) {
        alert("Spotify links require a proxy. Searching by text instead.");
    }

    // YouTube Search
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        
        list.innerHTML = '';
        if(!data.items || data.items.length === 0) {
            list.innerHTML = '<div class="empty-state">No results found.</div>';
            return;
        }

        data.items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'song-item';
            const song = {
                videoId: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.default.url,
                uploader: item.snippet.channelTitle
            };
            el.innerHTML = `
                <img src="${song.thumbnail}" class="thumb">
                <div class="meta"><h4>${song.title}</h4></div>
                <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
            `;
            el.querySelector('.add-btn').onclick = () => {
                addToQueue(song);
                alert("Added to queue!");
            };
            list.appendChild(el);
        });
    } catch(e) {
        console.error(e);
        list.innerHTML = '<div class="empty-state" style="color:red">Error: Check API Key</div>';
    }
}

async function fetchPlaylist(listId) {
    // Basic playlist fetcher
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20&playlistId=${listId}&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        if(data.items) {
            const updates = {};
            data.items.forEach((item, i) => {
                if(item.snippet.resourceId.kind === 'youtube#video') {
                    const k = queueRef.push().key;
                    updates[k] = {
                        videoId: item.snippet.resourceId.videoId,
                        title: item.snippet.title,
                        thumbnail: item.snippet.thumbnails.default.url,
                        uploader: item.snippet.channelTitle,
                        order: Date.now() + i
                    };
                }
            });
            queueRef.update(updates);
            window.switchTab('queue');
        }
    } catch(e) { console.error(e); }
}

function addToQueue(song) {
    const k = queueRef.push().key;
    queueRef.child(k).set({...song, order: Date.now()});
    // Auto-play if empty
    if(!currentVideoId) {
        currentVideoId = song.videoId;
        broadcastState('play', 0);
    }
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
            <button class="add-btn"><i class="fa-solid fa-trash"></i></button>
        `;
        // Click main body to play
        el.onclick = (e) => {
            if(!e.target.closest('.add-btn')) {
                currentVideoId = s.videoId;
                broadcastState('play', 0);
            }
        };
        // Click trash to remove
        el.querySelector('.add-btn').onclick = (e) => {
            e.stopPropagation();
            queueRef.child(s.key).remove();
        };
        list.appendChild(el);
    });
}

// 3. Chat Logic
document.getElementById('chatSendBtn').addEventListener('click', sendMessage);
document.getElementById('chatInput').addEventListener('keypress', (e) => { if(e.key==='Enter') sendMessage(); });

function sendMessage() {
    const input = document.getElementById('chatInput');
    const txt = input.value.trim();
    if(!txt) return;
    
    chatRef.push({
        user: myName,
        text: txt,
        timestamp: Date.now()
    });
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

// Force Sync Button
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    if(player) player.playVideo();
});

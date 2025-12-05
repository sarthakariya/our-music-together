// ================= CONFIGURATION =================
// NOTE: Please replace these with your actual keys and domains.
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
const db = firebase.database().ref('session_v5'); // New V5 node for strict sync
const chatRef = firebase.database().ref('chat_log'); // Dedicated chat node

// Variables
let player;
let queue = [];
let currentIndex = 0;
let lastKnownTime = 0;
let lastSkipCmd = 0;
let isDragging = false;
let myName = "Sarthak"; // Personalized name used for chat

// DOM Elements
const dom = {
    player: document.getElementById('player'),
    playBtn: document.getElementById('play-pause-btn'),
    title: document.getElementById('current-song-title'),
    seek: document.getElementById('seek-bar'),
    progress: document.getElementById('seek-progress'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    overlay: document.getElementById('syncOverlay'),
    searchIn: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count'),
    chatIn: document.getElementById('chatInput'),
    chatBox: document.getElementById('chat-messages')
};

// YouTube API boilerplate
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%',
        videoId: 'bTqVqk7FSmY',
        playerVars: { 
            'playsinline': 1, 'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    initSync();
    initChatListener();
    
    // UI Loop
    setInterval(updateUI, 500);
    // Master Status Check Loop
    setInterval(checkPlaybackStatus, 1000);
}

function onPlayerStateChange(e) {
    if (e.data === 0) playNext(); // Song ended
}

// ================= V5: STRICT SYNCHRONIZATION PROTOCOL =================

function initSync() {
    // 1. Listen for changes
    db.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        // Queue Sync (Crucial for reload fix)
        queue = data.queue || [];
        currentIndex = data.index || 0;
        renderQueue();

        if (queue.length > 0) {
            const song = queue[currentIndex];
            
            // ID Sync
            if (player.getVideoData().video_id !== song.id) {
                player.loadVideoById(song.id);
                dom.title.innerText = song.title;
            }

            // AD LOCK HANDLING (Priority 1)
            if (data.adDetected) {
                // If ad is detected anywhere, everyone pauses and sees the wait screen
                if(player.getPlayerState() !== 2) player.pauseVideo();
                if(!dom.overlay.classList.contains('active')) dom.overlay.classList.add('active');
            } else {
                // Normal Playback Sync (Priority 2)
                
                const serverStatus = data.status;
                const serverTime = data.time || 0;
                const skipCmd = data.skipCmd || 0;

                dom.overlay.classList.remove('active');
                
                // Status Sync
                if (serverStatus === 'playing') {
                    if (player.getPlayerState() !== 1) player.playVideo();
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
                } else {
                    if (player.getPlayerState() === 1) player.pauseVideo();
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
                }

                // Skip Command Execution (Tells viewers to skip/seek)
                if (skipCmd > lastSkipCmd) {
                    player.seekTo(serverTime, true);
                    lastSkipCmd = skipCmd;
                }
                // Standard Drift Correction
                else if (Math.abs(player.getCurrentTime() - serverTime) > 3) {
                    player.seekTo(serverTime, true);
                }
            }
        }
    });
}

// AD DETECTION & TIME BROADCAST
function checkPlaybackStatus() {
    if (!player || queue.length === 0) return;
    
    const state = player.getPlayerState();
    const curr = player.getCurrentTime();

    if (state === 1) { // If playing
        // If time hasn't moved in 1 sec, IT IS AN AD/BUFFER
        if (Math.abs(curr - lastKnownTime) < 0.1) {
            // My player is stuck, I'm issuing the lock
            db.update({ adDetected: true, status: 'paused' });
        } else {
            // Time is moving, I'm the time authority
            lastKnownTime = curr;
            db.update({ time: curr, adDetected: false });
        }
    }
}

// UNIVERSAL SKIP BUTTON
function forceSyncResume() {
    // Increment skipCmd (acts as an atomic command for viewers)
    // and force state back to playing
    db.update({ 
        skipCmd: Date.now(),
        adDetected: false,
        time: player.getCurrentTime() + 1, // Jump forward 1 second
        status: 'playing'
    });
}

// ================= QUEUE & PAGINATED PLAYLIST LOGIC =================

async function fetchPlaylist(listId, pageToken = null) {
    // Initial fetch or subsequent page fetch
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${YOUTUBE_API_KEY}` +
                (pageToken ? `&pageToken=${pageToken}` : '');
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.items) {
            const newSongs = data.items.map(item => ({
                id: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                thumb: item.snippet.thumbnails.default.url
            }));
            
            queue = [...queue, ...newSongs]; // Append songs to local queue
            
            // PAGINATION: If there is a next page token, fetch the next page!
            if (data.nextPageToken) {
                dom.title.innerText = `Loading... ${queue.length} songs so far.`;
                await fetchPlaylist(listId, data.nextPageToken);
                return; // Exit after successful recursive call
            }
            
            // FINISHED LOADING ALL PAGES
            db.update({ queue: queue });
            if (currentIndex === 0) {
                 db.update({ index: 0, status: 'playing' });
            }
            dom.searchIn.value = '';
            switchTab('queue');
        }
    } catch(e) {
        alert("Could not load playlist. API Quota might be exceeded or link invalid.");
    }
}

// ================= LIVE CHAT =================

function initChatListener() {
    chatRef.on('child_added', snap => {
        const msg = snap.val();
        renderMessage(msg.user, msg.message, msg.timestamp);
    });
}

window.sendMessage = function() {
    const text = dom.chatIn.value.trim();
    if (text) {
        chatRef.push({
            user: myName,
            message: text,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        dom.chatIn.value = '';
    }
}

function renderMessage(user, message, timestamp) {
    const div = document.createElement('div');
    div.className = `chat-message ${user === myName ? 'me' : 'partner'}`;
    const date = new Date(timestamp);
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
        <p><strong>${user}:</strong> ${message}</p>
        <small>${timeStr}</small>
    `;
    dom.chatBox.appendChild(div);
    // Scroll to bottom
    dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}

// ================= UI HELPERS (Unchanged but important) =================

// Volume (Local Only)
document.getElementById('volume-bar').addEventListener('input', (e) => {
    player.setVolume(e.target.value);
});

// Other functions (togglePlay, playNext, playPrev, syncSeek, manualSearch, searchYouTube, 
// addToQueue, renderQueue, deleteSong, clearQueue, updateUI, switchTab, formatTime) 
// remain largely the same as the previous version, ensuring they call the 'db' reference 
// for synchronization actions.

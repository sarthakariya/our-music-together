// ================= CONFIGURATION =================
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68"; // Replace if quota limit hit

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database().ref('session_v2'); // Using new node for clean start

// Global State
let player;
let queue = [];
let currentIndex = 0;
let lastKnownTime = 0;
let lastSkipTime = 0;
let isDragging = false;

// DOM Elements
const dom = {
    playBtn: document.getElementById('play-pause-btn'),
    disc: document.getElementById('music-disc'),
    art: document.getElementById('album-art'),
    title: document.getElementById('current-song-title'),
    seek: document.getElementById('seek-bar'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    overlay: document.getElementById('syncOverlay'),
    skipBtn: document.getElementById('sharedSkipButton'),
    searchIn: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count'),
    vol: document.getElementById('volume-bar')
};

// ================= YOUTUBE API =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '1', width: '1', videoId: 'bTqVqk7FSmY', // Default init
        playerVars: { 
            'playsinline': 1, 'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
// Load API
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    console.log("Connected to Love Player!");
    startSyncListener();
    
    // UI Update Loop (Local smoothness)
    setInterval(updateUI, 500);
    // Ad Detection Loop
    setInterval(checkAdStatus, 1000);
}

function onPlayerStateChange(e) {
    // If song ends, try to play next
    if (e.data === 0) playNext();
}

// ================= CORE SYNC LOGIC (The Heart) =================

function startSyncListener() {
    db.on('value', snap => {
        const data = snap.val();
        if (!data) return; // No data yet

        // 1. Queue Sync
        queue = data.queue || [];
        currentIndex = data.index || 0;
        renderQueue();

        if (queue.length > 0) {
            const song = queue[currentIndex];
            
            // Video ID Sync
            if (player.getVideoData().video_id !== song.id) {
                player.loadVideoById(song.id);
                dom.title.innerText = song.title;
                dom.art.style.backgroundImage = `url('${song.thumb}')`;
            }

            // 2. Playback Status Sync
            // We use the server status to dictate play/pause
            if (data.status === 'playing') {
                if (player.getPlayerState() !== 1) player.playVideo();
                dom.disc.classList.remove('paused');
                dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            } else {
                if (player.getPlayerState() === 1) player.pauseVideo();
                dom.disc.classList.add('paused');
                dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }

            // 3. Time Sync & Skip Logic
            const serverTime = data.time || 0;
            const skipCmd = data.skipCmd || 0;

            // If a skip command is newer than what we last processed
            if (skipCmd > lastSkipTime) {
                player.seekTo(serverTime + 1, true); // Jump forward
                lastSkipTime = skipCmd;
                dom.overlay.classList.remove('active'); // Hide shield
            } 
            // Normal drift correction (if off by > 4s and not overlay active)
            else if (!dom.overlay.classList.contains('active')) {
                if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
                    player.seekTo(serverTime, true);
                }
            }
            
            // 4. Ad/Overlay Sync
            if (data.adDetected && !dom.overlay.classList.contains('active')) {
                // Show button if Firebase says someone is stuck
                dom.overlay.classList.add('active');
                dom.sharedSkipButton.style.display = 'block';
            } else if (!data.adDetected) {
                dom.overlay.classList.remove('active');
            }
        }
    });
}

// ================= AD DETECTION (Zero Progress) =================
function checkAdStatus() {
    if (!player || queue.length === 0) return;
    
    const state = player.getPlayerState();
    const curr = player.getCurrentTime();

    // If Playing (1) but time hasn't moved in 1 sec -> Stuck/Ad
    if (state === 1) {
        if (Math.abs(curr - lastKnownTime) < 0.1) {
            // Signal Ad to everyone
            db.update({ adDetected: true });
        } else {
            // Time is moving, update 'time' for others to sync to
            // This acts as the "Master" clock - anyone playing updates the clock
            lastKnownTime = curr;
            db.update({ time: curr, adDetected: false });
        }
    }
}

// ================= SHARED CONTROLS =================

function togglePlay() {
    if (queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;
    // Immediate Local Feedback
    if (isPlaying) player.pauseVideo(); else player.playVideo();
    // Network Update
    db.update({ status: isPlaying ? 'paused' : 'playing' });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    db.update({ time: newTime });
}

function playNext() {
    if (currentIndex < queue.length - 1) {
        db.update({ index: currentIndex + 1, time: 0, status: 'playing' });
    } else {
        db.update({ status: 'paused', time: 0 }); // End of playlist
    }
}

function playPrev() {
    if (currentIndex > 0) {
        db.update({ index: currentIndex - 1, time: 0, status: 'playing' });
    } else {
        db.update({ time: 0 }); // Restart song
    }
}

// THE SHARED SKIP BUTTON
function skipAdSynchronized() {
    // Force everyone to jump to where my player currently is (or +1s)
    // Send a unique timestamp
    db.update({ 
        skipCmd: Date.now(),
        adDetected: false, // Hide button
        time: player.getCurrentTime() + 1
    });
}

// ================= QUEUE & SEARCH & PLAYLIST =================

function manualSearch() {
    const q = dom.searchIn.value;
    if (!q) return;

    // 1. Check for Playlist Link
    if (q.includes('list=')) {
        alert("Playlist detected! Note: Adding playlists requires extra API quota. For now, please add songs individually to be safe.");
        return;
    }

    // 2. Check for Video Link
    if (q.includes('v=')) {
        const id = q.split('v=')[1].split('&')[0];
        addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        return;
    }

    // 3. Regular Search
    searchYouTube(q);
    switchTab('results');
}

async function searchYouTube(q) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${q}&type=video&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.error) {
            dom.resList.innerHTML = `<div class="empty-state">⚠️ Error: ${data.error.message}</div>`;
            return;
        }

        dom.resList.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="thumb">
                <div class="info">
                    <h4>${item.snippet.title}</h4>
                </div>
                <button class="action-btn"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
            dom.resList.appendChild(div);
        });
    } catch (e) {
        dom.resList.innerHTML = `<div class="empty-state">Network Error. Try again.</div>`;
    }
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { id, title, thumb }];
    // If first song, play immediately
    if (queue.length === 0) {
        db.update({ queue: newQueue, index: 0, status: 'playing', time: 0 });
    } else {
        db.update({ queue: newQueue });
    }
    dom.searchIn.value = '';
    switchTab('queue');
}

function renderQueue() {
    dom.qCount.innerText = `${queue.length} Songs`;
    dom.qList.innerHTML = '';
    
    if (queue.length === 0) {
        dom.qList.innerHTML = '<div class="empty-state">Queue is empty 🎵</div>';
        return;
    }

    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = `song-item ${idx === currentIndex ? 'active-song' : ''}`;
        if (idx === currentIndex) div.style.background = 'rgba(255, 0, 127, 0.2)';
        
        div.innerHTML = `
            <img src="${song.thumb}" class="thumb">
            <div class="info">
                <h4>${song.title}</h4>
                <small>${idx === currentIndex ? 'Now Playing' : ''}</small>
            </div>
            <button class="action-btn" onclick="deleteSong(event, ${idx})"><i class="fa-solid fa-trash"></i></button>
        `;
        // Click to jump to song
        div.onclick = (e) => {
            if (!e.target.closest('.action-btn')) {
                db.update({ index: idx, status: 'playing', time: 0 });
            }
        };
        dom.qList.appendChild(div);
    });
}

// Global functions for HTML access
window.deleteSong = function(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = currentIndex;
    if (idx < currentIndex) newIdx--;
    db.update({ queue: newQueue, index: Math.max(0, newIdx) });
}

window.clearQueue = function() {
    if(confirm("Clear All?")) db.set(null);
}

// ================= UI HELPERS =================
dom.seek.addEventListener('input', () => { isDragging = true; });
dom.seek.addEventListener('change', () => {
    isDragging = false;
    const newTime = (dom.seek.value / 100) * player.getDuration();
    player.seekTo(newTime, true);
    db.update({ time: newTime });
});

dom.vol.addEventListener('input', (e) => {
    if(player) player.setVolume(e.target.value);
});

function updateUI() {
    if (!player || isDragging) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if (d) {
        dom.seek.value = (c / d) * 100;
        dom.curr.innerText = formatTime(c);
        dom.dur.innerText = formatTime(d);
    }
}

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.scroll-list').forEach(l => l.classList.remove('active'));
    
    if (tab === 'queue') {
        dom.qList.classList.add('active');
        document.querySelector('.tab-btn:first-child').classList.add('active');
    } else {
        dom.resList.classList.add('active');
        document.querySelector('.tab-btn:last-child').classList.add('active');
    }
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

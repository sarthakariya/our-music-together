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
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

firebase.initializeApp(firebaseConfig);
const db = firebase.database().ref('session_v4'); // New session V4

let player;
let queue = [];
let currentIndex = 0;
let lastKnownTime = 0;
let lastSkipCmd = 0;
let isDragging = false;

const dom = {
    player: document.getElementById('player'),
    playBtn: document.getElementById('play-pause-btn'),
    disc: document.getElementById('music-disc'),
    art: document.getElementById('album-art'),
    title: document.getElementById('current-song-title'),
    seek: document.getElementById('seek-bar'),
    progress: document.getElementById('seek-progress'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    overlay: document.getElementById('syncOverlay'),
    searchIn: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count')
};

// ================= YOUTUBE API =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%',
        videoId: 'bTqVqk7FSmY', // Placeholder
        playerVars: { 
            'playsinline': 1, 'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    console.log("Connected.");
    // IMMEDIATE RELOAD FIX: Check DB state right now
    initSync();
    
    // UI Loop
    setInterval(updateUI, 500);
    // Ad Check Loop
    setInterval(checkAdStatus, 1000);
}

function onPlayerStateChange(e) {
    if (e.data === 0) playNext();
}

// ================= SYNC LOGIC =================

function initSync() {
    // 1. Listen for changes
    db.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        // Queue Sync
        queue = data.queue || [];
        currentIndex = data.index || 0;
        renderQueue();

        if (queue.length > 0) {
            const song = queue[currentIndex];
            
            // ID Sync
            if (player.getVideoData().video_id !== song.id) {
                player.loadVideoById(song.id);
                dom.title.innerText = song.title;
                dom.art.style.backgroundImage = `url('${song.thumb}')`;
            }

            // Status Sync
            const serverStatus = data.status;
            if (serverStatus === 'playing') {
                if (player.getPlayerState() !== 1) player.playVideo();
                dom.disc.classList.remove('paused');
                dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            } else {
                if (player.getPlayerState() === 1) player.pauseVideo();
                dom.disc.classList.add('paused');
                dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }

            // Time & Skip Sync
            const serverTime = data.time || 0;
            const skipCmd = data.skipCmd || 0;

            if (skipCmd > lastSkipCmd) {
                // FORCE SKIP EXECUTION
                player.seekTo(serverTime + 1, true);
                lastSkipCmd = skipCmd;
                dom.overlay.classList.remove('active');
            } 
            else if (!dom.overlay.classList.contains('active')) {
                // Standard Drift Correction
                if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
                    player.seekTo(serverTime, true);
                }
            }

            // Ad Overlay Sync
            if (data.adDetected) {
                if(!dom.overlay.classList.contains('active')) dom.overlay.classList.add('active');
            } else {
                dom.overlay.classList.remove('active');
            }
        }
    });
}

// ================= AD DETECTION =================
function checkAdStatus() {
    if (!player || queue.length === 0) return;
    
    const state = player.getPlayerState();
    const curr = player.getCurrentTime();

    if (state === 1) { // If playing
        // If time hasn't moved in 1 sec, IT IS AN AD/BUFFER
        if (Math.abs(curr - lastKnownTime) < 0.1) {
            db.update({ adDetected: true });
        } else {
            // Time is moving, I am the source of truth
            lastKnownTime = curr;
            db.update({ time: curr, adDetected: false });
        }
    }
}

// ================= CONTROLS =================

function togglePlay() {
    if (queue.length === 0) return;
    db.once('value', snap => {
        const status = snap.val()?.status;
        db.update({ status: status === 'playing' ? 'paused' : 'playing' });
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    db.update({ time: newTime });
}

function playNext() {
    if (currentIndex < queue.length - 1) {
        db.update({ index: currentIndex + 1, time: 0, status: 'playing' });
    }
}

function playPrev() {
    if (currentIndex > 0) {
        db.update({ index: currentIndex - 1, time: 0, status: 'playing' });
    }
}

// UNIVERSAL SKIP BUTTON
function forceSyncResume() {
    // Force jump +1s and resume
    db.update({ 
        skipCmd: Date.now(),
        adDetected: false,
        time: player.getCurrentTime() + 1,
        status: 'playing'
    });
}

// ================= QUEUE & PLAYLIST LOGIC =================

function manualSearch() {
    const q = dom.searchIn.value;
    if (!q) return;

    // 1. PLAYLIST HANDLING
    if (q.includes('list=')) {
        const listId = q.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        return;
    }

    // 2. VIDEO LINK
    if (q.includes('v=')) {
        const id = q.split('v=')[1].split('&')[0];
        addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        return;
    }

    // 3. REGULAR SEARCH
    searchYouTube(q);
    switchTab('results');
}

async function fetchPlaylist(listId) {
    // API Call to get playlist items (Cost: 1 unit)
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.items) {
            const newSongs = data.items.map(item => ({
                id: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                thumb: item.snippet.thumbnails.default.url
            }));
            
            // Add entire batch to queue
            const updatedQueue = [...queue, ...newSongs];
            db.update({ queue: updatedQueue });
            
            // Auto play if queue was empty
            if (queue.length === 0) {
                db.update({ index: 0, status: 'playing' });
            }
            
            dom.searchIn.value = '';
            switchTab('queue');
        }
    } catch(e) {
        alert("Could not load playlist. API Quota might be exceeded.");
    }
}

async function searchYouTube(q) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${q}&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    
    dom.resList.innerHTML = '';
    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="thumb">
            <div class="meta"><h4>${item.snippet.title}</h4></div>
            <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
        `;
        div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
        dom.resList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { id, title, thumb }];
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
    if(queue.length === 0) dom.qList.innerHTML = '<div class="empty-state">Queue is empty</div>';
    
    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = `song-item ${idx === currentIndex ? 'playing' : ''}`;
        div.innerHTML = `
            <img src="${song.thumb}" class="thumb">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>${idx === currentIndex ? 'NOW PLAYING' : ''}</p>
            </div>
            <button onclick="deleteSong(event, ${idx})" class="del-btn"><i class="fa-solid fa-xmark"></i></button>
        `;
        div.onclick = (e) => {
            if(!e.target.closest('.del-btn')) db.update({ index: idx, status: 'playing', time: 0 });
        }
        dom.qList.appendChild(div);
    });
}

window.deleteSong = function(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = currentIndex;
    if (idx < currentIndex) newIdx--;
    db.update({ queue: newQueue, index: Math.max(0, newIdx) });
}

window.clearQueue = function() {
    if(confirm("Clear Queue?")) db.set(null);
}

// ================= UI HELPERS =================
dom.seek.addEventListener('input', () => { isDragging = true; });
dom.seek.addEventListener('change', () => {
    isDragging = false;
    const time = (dom.seek.value / 100) * player.getDuration();
    player.seekTo(time, true);
    db.update({ time: time });
});

function updateUI() {
    if (!player || isDragging) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if (d) {
        dom.seek.value = (c / d) * 100;
        dom.progress.style.width = `${(c/d)*100}%`;
        dom.curr.innerText = formatTime(c);
        dom.dur.innerText = formatTime(d);
    }
}

function switchTab(t) {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(l => l.classList.remove('active'));
    if(t === 'queue') {
        dom.qList.classList.add('active');
        document.querySelector('.tab:first-child').classList.add('active');
    } else {
        dom.resList.classList.add('active');
        document.querySelector('.tab:last-child').classList.add('active');
    }
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

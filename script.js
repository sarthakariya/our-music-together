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
const database = firebase.database();
const syncRef = database.ref('session');

// ================= VARIABLES =================
let player;
let queue = [];
let queueIndex = 0;
let isDragging = false;
let syncInterval;

const dom = {
    disc: document.getElementById('music-disc'),
    discArt: document.querySelector('.vinyl-center'),
    title: document.getElementById('current-song-title'),
    status: document.getElementById('statusText'),
    playBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    currentTime: document.getElementById('current-time'),
    duration: document.getElementById('duration'),
    searchInput: document.getElementById('searchInput'),
    resultsList: document.getElementById('results-list'),
    queueList: document.getElementById('queue-list'),
    queueCount: document.getElementById('queue-count')
};

// ================= YOUTUBE SETUP =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: 'M7lc1UVf-VE',
        playerVars: { 
            'playsinline': 1, 'controls': 0, 'rel': 0, 'disablekb': 1, 
            'fs': 0, 'iv_load_policy': 3, 'html5': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
// Load API
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    listenForSync();
    setInterval(updateProgress, 500);
    // AD/SYNC ENFORCER: Checks every 2 seconds if we are desynced
    setInterval(enforceSync, 2000);
}

// ================= LOGIC: AD HANDLING & SYNC ENFORCEMENT =================

function onPlayerStateChange(e) {
    if (e.data === 0) { // Song Ended
        playNext();
    } 
    else if (e.data === 3) { // Buffering (AD detected)
        dom.statusText.innerText = "Buffering/Ad detected - Waiting to sync...";
        // We don't pause the other person, but we prepare to jump when we are back
    }
}

// This function forces your player to jump to the Firebase time if you lag behind (e.g., after an ad)
function enforceSync() {
    if (!player || !queue.length) return;
    
    syncRef.once('value').then(snap => {
        const data = snap.val();
        if (data && data.status === 'play') {
            const serverTime = data.seekTime + ((Date.now() - data.timestamp) / 1000);
            const myTime = player.getCurrentTime();

            // If we are more than 3 seconds off, FORCE JUMP
            if (Math.abs(myTime - serverTime) > 3) {
                console.log("Desync detected (Ad? Lag?). Forcing jump.");
                player.seekTo(serverTime, true);
                player.playVideo();
            }
        }
    });
}

// ================= LOGIC: PLAYBACK & QUEUE =================

function playNext() {
    // Remove the finished song from the queue visually and logically
    if (queue.length > 0) {
        // queue.shift(); // Optional: Remove from array if you want it gone forever
        // For now, we just move index
        if (queueIndex < queue.length - 1) {
            updateFirebase({ queueIndex: queueIndex + 1, status: 'play', seekTime: 0 });
        } else {
            updateFirebase({ status: 'pause' }); // End of playlist
        }
    }
}

function updateFirebase(updates) {
    updates.timestamp = Date.now();
    syncRef.update(updates);
}

function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        
        renderQueueUI();

        if (queue.length > 0) {
            const song = queue[queueIndex];
            
            // 1. Sync Song Data
            if (player.getVideoData().video_id !== song.videoId) {
                player.loadVideoById(song.videoId);
                dom.title.innerText = song.title;
                dom.discArt.style.backgroundImage = `url('${song.thumbnail}')`;
            }

            // 2. Sync Status
            if (data.status === 'play') {
                if(player.getPlayerState() !== 1) player.playVideo();
                dom.disc.style.animationPlayState = 'running';
                dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
                dom.status.innerText = "Synced & Playing";
            } else {
                if(player.getPlayerState() === 1) player.pauseVideo();
                dom.disc.style.animationPlayState = 'paused';
                dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
                dom.status.innerText = "Paused";
            }

            // 3. Initial Seek (only if huge difference, handled by Enforcer mostly)
            if (Math.abs(player.getCurrentTime() - data.seekTime) > 5) {
                player.seekTo(data.seekTime, true);
            }
        } else {
            dom.title.innerText = "Queue Empty";
            dom.status.innerText = "Search to add songs";
            dom.disc.style.animationPlayState = 'paused';
        }
    });
}

function togglePlay() {
    if(queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;
    updateFirebase({ status: isPlaying ? 'pause' : 'play', seekTime: player.getCurrentTime() });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    updateFirebase({ seekTime: newTime });
}

// Manual Seek Bar
dom.seekBar.addEventListener('input', () => { isDragging = true; });
dom.seekBar.addEventListener('change', () => {
    isDragging = false;
    const time = (dom.seekBar.value / 100) * player.getDuration();
    updateFirebase({ seekTime: time });
});

function updateProgress() {
    if (!player || isDragging) return;
    const curr = player.getCurrentTime();
    const dur = player.getDuration();
    if(dur) {
        dom.seekBar.value = (curr / dur) * 100;
        dom.currentTime.innerText = formatTime(curr);
        dom.duration.innerText = formatTime(dur);
    }
}

// ================= LOGIC: SEARCH & UI =================

// LIVE SEARCH LISTENER
dom.searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    if (query.length > 2) {
        searchYouTube(query);
        switchTab('results');
    }
});

async function searchYouTube(query) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${query}&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    
    dom.resultsList.innerHTML = '';
    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
            <div class="song-meta">
                <h4>${item.snippet.title}</h4>
                <p>Click to Add</p>
            </div>
        `;
        div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
        dom.resultsList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    // If empty, auto play
    if (queue.length === 0) {
        updateFirebase({ queue: newQueue, queueIndex: 0, status: 'play' });
    } else {
        updateFirebase({ queue: newQueue });
    }
    // Visual feedback
    dom.searchInput.value = '';
    switchTab('queue');
}

function renderQueueUI() {
    dom.queueCount.innerText = `(${queue.length})`;
    dom.queueList.innerHTML = '';
    
    // Auto-remove previous songs from UI visualization (Optional)
    // We only show songs from current index onwards
    const visibleQueue = queue.slice(queueIndex); 

    if (visibleQueue.length === 0) {
        dom.queueList.innerHTML = '<div class="empty-state">No more songs in queue</div>';
        return;
    }

    visibleQueue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        // Highlight current song
        if (idx === 0) div.style.background = 'rgba(108, 99, 255, 0.2)'; 
        
        div.innerHTML = `
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-meta">
                <h4>${song.title}</h4>
                <p>${idx === 0 ? 'Now Playing' : 'Up Next'}</p>
            </div>
        `;
        dom.queueList.appendChild(div);
    });
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.scroll-list').forEach(l => l.classList.remove('active-list'));
    
    if (tab === 'results') {
        document.querySelector('.tab:nth-child(1)').classList.add('active');
        dom.resultsList.classList.add('active-list');
    } else {
        document.querySelector('.tab:nth-child(2)').classList.add('active');
        dom.queueList.classList.add('active-list');
    }
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

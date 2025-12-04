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
let myPlayerState = -1; // -1 unstarted, 1 playing, 2 paused, 3 buffering

const dom = {
    blocker: document.getElementById('sync-blocker'),
    disc: document.getElementById('music-disc'),
    discArt: document.querySelector('.vinyl-center'),
    title: document.getElementById('current-song-title'),
    playBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    currTime: document.getElementById('current-time'),
    durTime: document.getElementById('duration'),
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
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    listenForSync();
    setInterval(updateProgress, 500);
}

// ================= AD & SYNC LOGIC (THE FIX) =================

function onPlayerStateChange(e) {
    myPlayerState = e.data;
    
    // 0 = Ended
    if (e.data === 0) playNext();
    
    // 3 = Buffering (Often Ads) OR -1 (Unstarted/Ad)
    if (e.data === 3 || e.data === -1) {
        // I am buffering/lagging. Tell everyone to WAIT.
        updateFirebase({ isBuffering: true });
    } else if (e.data === 1) {
        // I am playing again. Tell everyone I'm ready.
        updateFirebase({ isBuffering: false });
    }
}

// The heart of the sync
function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        
        renderQueueUI();

        // 1. AD/BUFFER SHIELD LOGIC
        // If ANYONE is buffering, show shield to EVERYONE
        if (data.isBuffering) {
            dom.blocker.classList.add('active');
            if (myPlayerState === 1) player.pauseVideo(); // Pause me if I'm ahead
        } else {
            dom.blocker.classList.remove('active');
        }

        if (queue.length > 0) {
            const song = queue[queueIndex];

            // 2. VIDEO ID
            if (player.getVideoData().video_id !== song.videoId) {
                player.loadVideoById(song.videoId);
                dom.title.innerText = song.title;
                dom.discArt.style.backgroundImage = `url('${song.thumbnail}')`;
            }

            // 3. PLAY/PAUSE (Only if not buffering)
            if (!data.isBuffering) {
                if (data.status === 'play') {
                    if (player.getPlayerState() !== 1) player.playVideo();
                    dom.disc.style.animationPlayState = 'running';
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
                } else {
                    if (player.getPlayerState() === 1) player.pauseVideo();
                    dom.disc.style.animationPlayState = 'paused';
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
                }
                
                // 4. SEEK SYNC (Approximate)
                if (Math.abs(player.getCurrentTime() - data.seekTime) > 4) {
                    player.seekTo(data.seekTime, true);
                }
            }
        } else {
            dom.title.innerText = "SYSTEM READY";
            dom.disc.style.animationPlayState = 'paused';
        }
    });
}

function updateFirebase(updates) {
    syncRef.update(updates);
}

// ================= CONTROLS =================

function togglePlay() {
    if(queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;
    updateFirebase({ 
        status: isPlaying ? 'pause' : 'play', 
        seekTime: player.getCurrentTime(),
        isBuffering: false // Manual action clears buffer state
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    updateFirebase({ seekTime: newTime });
}

function playNext() {
    if (queueIndex < queue.length - 1) {
        updateFirebase({ queueIndex: queueIndex + 1, status: 'play', seekTime: 0, isBuffering: false });
    } else {
        updateFirebase({ status: 'pause', isBuffering: false });
    }
}

// ================= QUEUE MANAGEMENT =================

function renderQueueUI() {
    dom.queueCount.innerText = `(${queue.length})`;
    dom.queueList.innerHTML = '';
    
    if (queue.length === 0) {
        dom.queueList.innerHTML = '<div class="empty-state">QUEUE EMPTY</div>';
        return;
    }

    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        if (idx === queueIndex) div.style.borderLeft = '3px solid #00f2ff';
        
        div.innerHTML = `
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-meta">
                <h4>${song.title}</h4>
                <p>${idx === queueIndex ? 'PLAYING' : 'QUEUED'}</p>
            </div>
            <div class="delete-btn" onclick="removeFromQueue(event, ${idx})">
                <i class="fa-solid fa-xmark"></i>
            </div>
        `;
        // Click to jump to song
        div.onclick = (e) => {
             if(!e.target.closest('.delete-btn')) {
                 updateFirebase({ queueIndex: idx, status: 'play', seekTime: 0 });
             }
        };
        dom.queueList.appendChild(div);
    });
}

// DELETE FUNCTION
window.removeFromQueue = function(e, index) {
    e.stopPropagation(); // Stop click from playing song
    const newQueue = [...queue];
    newQueue.splice(index, 1);
    
    // Adjust index if we deleted a song before current
    let newIndex = queueIndex;
    if (index < queueIndex) newIndex--;
    if (newQueue.length === 0) newIndex = 0;

    updateFirebase({ queue: newQueue, queueIndex: newIndex });
}

window.clearQueue = function() {
    if(confirm("Clear entire queue?")) {
        updateFirebase({ queue: [], queueIndex: 0, status: 'pause' });
    }
}

// ================= SEARCH =================
dom.searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    // Check if it's a YouTube Link
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
        const videoId = query.split('v=')[1]?.split('&')[0] || query.split('/').pop();
        if(videoId) addToQueue(videoId, "Shared Link Song", "https://img.youtube.com/vi/"+videoId+"/default.jpg");
        return;
    }
    if (query.length > 2) {
        searchYouTube(query);
        switchTab('results');
    }
});

async function searchYouTube(query) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${query}&type=video&key=${YOUTUBE_API_KEY}`;
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
            </div>
            <i class="fa-solid fa-plus" style="color:#00f2ff"></i>
        `;
        div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
        dom.resultsList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    if (queue.length === 0) {
        updateFirebase({ queue: newQueue, queueIndex: 0, status: 'play' });
    } else {
        updateFirebase({ queue: newQueue });
    }
    dom.searchInput.value = '';
    switchTab('queue');
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

// UI HELPERS
dom.seekBar.addEventListener('change', () => {
    const time = (dom.seekBar.value / 100) * player.getDuration();
    updateFirebase({ seekTime: time });
});
function updateProgress() {
    if (!player || dom.blocker.classList.contains('active')) return;
    const curr = player.getCurrentTime();
    const dur = player.getDuration();
    if(dur) {
        dom.seekBar.value = (curr / dur) * 100;
        dom.currTime.innerText = formatTime(curr);
        dom.durTime.innerText = formatTime(dur);
    }
}
function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

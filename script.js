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
let myState = -1; 

const dom = {
    overlay: document.getElementById('sync-blocker'),
    msg: document.getElementById('blocker-text'),
    disc: document.getElementById('music-disc'),
    art: document.querySelector('.vinyl-center'),
    title: document.getElementById('current-song-title'),
    playBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    search: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count')
};

// ================= YOUTUBE SETUP =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: 'M7lc1UVf-VE',
        playerVars: { 
            'playsinline': 1, // CRITICAL FOR MOBILE
            'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1
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

// ================= THE "AD-WAIT" PROTOCOL =================
function onPlayerStateChange(e) {
    myState = e.data;
    
    // 0 = Ended (Song finished)
    if (e.data === 0) playNext();
    
    // 3 = Buffering, -1 = Unstarted (Often Ad on Mobile)
    if (e.data === 3 || e.data === -1) {
        updateFirebase({ isBuffering: true });
    } 
    // 1 = Playing (Ad finished or song playing)
    else if (e.data === 1) {
        updateFirebase({ isBuffering: false });
    }
}

function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        
        renderQueueUI();

        // 1. SYNC SHIELD: If ANYONE is buffering, EVERYONE waits
        if (data.isBuffering) {
            dom.overlay.classList.add('active');
            dom.msg.innerText = "WAITING FOR PARTNER...";
            if (myState === 1) player.pauseVideo(); // Pause local if partner has ad
        } else {
            dom.overlay.classList.remove('active');
        }

        if (queue.length > 0) {
            const song = queue[queueIndex];

            // 2. VIDEO ID SYNC
            if (player.getVideoData().video_id !== song.videoId) {
                player.loadVideoById(song.videoId);
                dom.title.innerText = song.title;
                dom.art.style.backgroundImage = `url('${song.thumbnail}')`;
            }

            // 3. PLAY/PAUSE SYNC (Only if shield is down)
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
                
                // 4. TIME JUMP (Force Sync)
                // If we drifted more than 4 seconds, snap to server time
                const serverTime = data.seekTime || 0;
                if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
                    player.seekTo(serverTime, true);
                }
            }
        } else {
            dom.title.innerText = "Select a Song";
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
    // When pressing play/pause manually, we force buffering to false to unlock shield
    updateFirebase({ 
        status: isPlaying ? 'pause' : 'play', 
        seekTime: player.getCurrentTime(),
        isBuffering: false 
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

// ================= SEARCH & QUEUE =================
dom.search.addEventListener('input', (e) => {
    const q = e.target.value;
    if (q.includes('youtu')) { // Link detection
        const id = q.split('v=')[1]?.split('&')[0] || q.split('/').pop();
        if(id) addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        return;
    }
    if (q.length > 2) {
        searchYouTube(q);
        switchTab('results');
    }
});

async function searchYouTube(q) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${q}&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    dom.resList.innerHTML = '';
    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
            <div class="song-meta"><h4>${item.snippet.title}</h4></div>
            <i class="fa-solid fa-plus" style="color:#00cec9"></i>
        `;
        div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
        dom.resList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    if (queue.length === 0) {
        updateFirebase({ queue: newQueue, queueIndex: 0, status: 'play' });
    } else {
        updateFirebase({ queue: newQueue });
    }
    dom.search.value = '';
    switchTab('queue');
}

function renderQueueUI() {
    dom.qCount.innerText = `(${queue.length})`;
    dom.qList.innerHTML = '';
    if (queue.length === 0) { dom.qList.innerHTML = '<div class="empty-state">QUEUE EMPTY</div>'; return; }
    
    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        if (idx === queueIndex) div.style.background = 'rgba(108, 92, 231, 0.2)';
        
        div.innerHTML = `
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-meta">
                <h4>${song.title}</h4>
                <p style="font-size:10px; color:#888">${idx === queueIndex ? 'PLAYING' : 'QUEUED'}</p>
            </div>
            <i class="fa-solid fa-xmark" style="padding:10px; color:#ff4757" onclick="deleteSong(event, ${idx})"></i>
        `;
        div.onclick = (e) => { if(!e.target.classList.contains('fa-xmark')) updateFirebase({ queueIndex: idx, status: 'play', seekTime: 0 }); };
        dom.qList.appendChild(div);
    });
}

window.deleteSong = function(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = queueIndex;
    if (idx < queueIndex) newIdx--;
    updateFirebase({ queue: newQueue, queueIndex: newIdx < 0 ? 0 : newIdx });
}

window.clearQueue = function() {
    if(confirm("Clear Queue?")) updateFirebase({ queue: [], queueIndex: 0, status: 'pause' });
}

function switchTab(t) {
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.scroll-list').forEach(el => el.classList.remove('active-list'));
    if (t === 'results') {
        dom.resList.classList.add('active-list');
        document.querySelector('.tab:nth-child(1)').classList.add('active');
    } else {
        dom.qList.classList.add('active-list');
        document.querySelector('.tab:nth-child(2)').classList.add('active');
    }
}

// UI HELPERS
dom.seekBar.addEventListener('change', () => {
    const time = (dom.seekBar.value / 100) * player.getDuration();
    updateFirebase({ seekTime: time });
});
function updateProgress() {
    if (!player || dom.overlay.classList.contains('active')) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if(d) {
        dom.seekBar.value = (c / d) * 100;
        dom.curr.innerText = formatTime(c);
        dom.dur.innerText = formatTime(d);
    }
}
function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

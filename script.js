// ================= CONFIGURATION & VARIABLES =================
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

let player;
let queue = [];
let queueIndex = 0;
let isDragging = false;
let myState = -1; // -1 unstarted, 1 playing, 2 paused, 3 buffering

// Core Sync Variables
const playerRef = database.ref('playerStatus/' + new Date().getTime()); // Unique reference for this device
let lagStartTime = null; // Tracks when the current lag started
let lagUpdateInterval; // Interval to update the "Lagging for X seconds" text


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
    // Start monitoring: 500ms for UI, 1000ms for Heartbeat
    setInterval(updateProgress, 500);
    setInterval(sendHeartbeat, 1000); 
    
    // Cleanup players who leave the session (15-minute interval)
    setInterval(removeStaleHeartbeats, 900000); 
}

function onPlayerStateChange(e) {
    myState = e.data;
    if (e.data === 0) playNext(); // 0 = Ended
}

function updateFirebase(updates) {
    syncRef.update(updates);
}


// ================= AD & SYNC LOGIC (HEARTBEAT FIX) =================

function sendHeartbeat() {
    // Only send heartbeats when the player is actively playing (State 1)
    if (!player || queue.length === 0 || player.getPlayerState() !== 1) return; 

    const currentTime = player.getCurrentTime();
    
    // Report my status and current time
    playerRef.update({
        time: currentTime,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        isSeeking: isDragging,
        queueIndex: queueIndex
    });
}

function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        
        // RENDER QUEUE UI
        renderQueueUI();
        
        // HEARTBEAT MONITORING - Checks for lagging partners and enforces pause/wait
        checkPartnerHeartbeat(data);

        if (queue.length > 0) {
            const song = queue[queueIndex];

            // 1. VIDEO ID SYNC: Load the correct video if needed
            if (player.getVideoData().video_id !== song.videoId) {
                player.loadVideoById(song.videoId);
                dom.title.innerText = song.title;
                dom.art.style.backgroundImage = `url('${song.thumbnail}')`;
            }
            
            // 2. TIME JUMP (Force Sync) - Only sync time if the overlay is NOT active
            if (!dom.overlay.classList.contains('active')) {
                const serverTime = data.seekTime || 0;
                // Check if we are outside the 4 second sync window
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


function checkPartnerHeartbeat(syncData) {
    database.ref('playerStatus').once('value', snapshot => {
        let isAnyPartnerLagging = false;
        let oldestTimestamp = Date.now();
        let oldestPartnerId = null;

        // PASS 1: Find the oldest (most lagged) partner
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            const partnerId = childSnap.key;

            if (partnerId === playerRef.key) return; 
            if (partnerData.queueIndex !== queueIndex) return; 

            if (partnerData.timestamp < oldestTimestamp) {
                oldestTimestamp = partnerData.timestamp;
                oldestPartnerId = partnerId;
            }
        });

        // PASS 2: Check for actual lag, but exclude the oldest partner (to prevent the feedback loop)
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            const partnerId = childSnap.key;
            
            // Skip my own player AND skip the player that is currently lagging the most
            if (partnerId === playerRef.key || partnerId === oldestPartnerId) return;

            const timeSinceLastUpdate = Date.now() - partnerData.timestamp;

            // DETECT LAG: If time hasn't updated in 5s AND we should be playing globally
            if (timeSinceLastUpdate > 5000 && syncData.status === 'play' && !partnerData.isSeeking) {
                isAnyPartnerLagging = true;
                return;
            }
        });

        // ------------------ ACTION LOGIC ------------------

        if (isAnyPartnerLagging) {
            
            // 1. Start/Check Lag Timer
            if (lagStartTime === null) {
                lagStartTime = Date.now();
                if (!lagUpdateInterval) {
                     lagUpdateInterval = setInterval(updateLagUI, 1000);
                }
            }
            const timeElapsed = Date.now() - lagStartTime;
            const timeLimit = 120000; // 2 minutes (120 seconds)
            const secondsRemaining = Math.max(0, Math.floor((timeLimit - timeElapsed) / 1000));
            
            // 2. FORCE RESUME IF TIMEOUT EXCEEDED
            if (timeElapsed >= timeLimit) {
                console.log("[SYNC] Auto-resuming due to 2-minute timeout.");
                lagStartTime = null; 
                window.resumeSync();
                return;
            }

            // 3. APPLY SHIELD
            dom.overlay.classList.add('active');
            dom.msg.innerText = "HEARTBEAT LOST";
            
            if (myState === 1) player.pauseVideo();
            dom.disc.style.animationPlayState = 'paused';
            dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            
            document.getElementById('sync-timer').innerText = secondsRemaining;

        } else {
            // No lag detected: Resume normal operation
            lagStartTime = null; 
            
            if (lagUpdateInterval) {
                clearInterval(lagUpdateInterval);
                lagUpdateInterval = null;
            }

            dom.overlay.classList.remove('active');
            
            // Re-apply the global play/pause status from Firebase
            if (syncData.status === 'play' && myState !== 1) {
                player.playVideo();
                dom.disc.style.animationPlayState = 'running';
                dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            } else if (syncData.status === 'pause' && myState === 1) {
                player.pauseVideo();
                dom.disc.style.animationPlayState = 'paused';
                dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }
        }
    });
}

// ================= GRACEFUL EXIT & LAG MONITORING =================

function removeStaleHeartbeats() {
    const STALE_TIMEOUT_MS = 900000; // 15 minutes (15 * 60 * 1000)
    const cutoff = Date.now() - STALE_TIMEOUT_MS;

    database.ref('playerStatus').once('value', snapshot => {
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            
            if (partnerData.timestamp < cutoff) {
                database.ref('playerStatus/' + childSnap.key).remove()
                    .then(() => {
                        console.log(`[SYNC] Removed stale player: ${childSnap.key}`);
                    });
            }
        });
    });
}

function updateLagUI() {
    if (lagStartTime) {
        const timeElapsed = Date.now() - lagStartTime;
        const secondsElapsed = Math.floor(timeElapsed / 1000);
        document.getElementById('lag-status').innerText = `Monitoring delay: ${secondsElapsed} seconds`;
    }
}

window.resumeSync = function() {
    // Clear the UI countdown interval and reset lag variables
    if (lagUpdateInterval) {
        clearInterval(lagUpdateInterval);
        lagUpdateInterval = null;
    }
    lagStartTime = null;

    // Clear the active shield
    dom.overlay.classList.remove('active');
    
    // Force the global status to "play" based on my current time
    updateFirebase({ 
        status: 'play', 
        seekTime: player.getCurrentTime() || 0,
    });
}

// ================= CONTROLS & UI HELPERS =================

function togglePlay() {
    if(queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;
    updateFirebase({ 
        status: isPlaying ? 'pause' : 'play', 
        seekTime: player.getCurrentTime(),
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    updateFirebase({ seekTime: newTime });
}

function playNext() {
    if (queueIndex < queue.length - 1) {
        updateFirebase({ queueIndex: queueIndex + 1, status: 'play', seekTime: 0 });
    } else {
        updateFirebase({ status: 'pause', seekTime: 0 });
    }
}

// ================= SEARCH & QUEUE =================

dom.search.addEventListener('input', (e) => {
    const q = e.target.value;
    
    // Check if it's a YouTube Link or ID
    if (q.includes('youtu')) { 
        const id = q.split('v=')[1]?.split('&')[0] || q.split('/').pop();
        if(id) {
            addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        }
        return;
    }
    
    // Proceed with text search (live search)
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
    
    if (data.items.length === 0) {
        dom.resList.innerHTML = '<div class="empty-state">NO RESULTS FOUND</div>';
    }

    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        const safeTitle = item.snippet.title.replace(/'/g, "\\'");
        
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
            <div class="song-meta"><h4>${item.snippet.title}</h4></div>
            <i class="fa-solid fa-plus" style="padding:10px; color:#00cec9" onclick="addToQueue('${item.id.videoId}', '${safeTitle}', '${item.snippet.thumbnails.default.url}')"></i>
        `;
        dom.resList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    if (queue.length === 0) {
        updateFirebase({ queue: newQueue, queueIndex: 0, status: 'play', seekTime: 0 });
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
            <i class="fa-solid fa-xmark" style="padding:10px; color:#ff4757" onclick="window.deleteSong(event, ${idx})"></i>
        `;
        div.onclick = (e) => { 
            if(!e.target.classList.contains('fa-xmark')) {
                updateFirebase({ queueIndex: idx, status: 'play', seekTime: 0 });
            }
        };
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
